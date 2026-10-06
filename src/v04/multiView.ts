import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import type {Knex} from 'knex';
import {z} from 'zod';
import {db} from '@/utils/db';
import getPath from '@/utils/getPath';
import {PilotError} from './service';
import {captureAutoAssetReadContext,autoJobFresh,preparedSpec} from './autoAsset';
import {compileStudioDraftPromptsInTransaction} from './visualSpec';
import {resolveEditRouting} from './operations';
import {buildKreaEditWorkflow,uploadEditInput,KREA_EDIT_WORKFLOW_VERSION} from './kreaImageEditProfile';
import {graphFacts} from './operationsRegistry';
import {awaitDraft,downloadDraft,localComfyOrigin,DraftComfyError} from './comfyDraftClient';
import {submitTracedDraft} from './tracedDraftSubmit';
import {acquireDraftWorkerLease} from './draftWorkerLease';
import {MULTIVIEW_TABLE as table} from './multiViewSchema';
import {MULTIVIEW_VERSION,multiViewHash as hash,resolveMultiViewBoy,compileMultiViewBrief,multiViewSides} from './multiViewCompiler';
const q=db as Knex;
const scope=z.object({projectId:z.number().int().positive(),scriptId:z.number().int().positive()}).strict();
const command=scope.extend({experimentId:z.string().uuid()}).strict();
const renderRequest=command.extend({experimentHash:z.string().regex(/^[a-f0-9]{64}$/),confirmRender:z.literal(true),sourceQualityConfirmed:z.literal(true)}).strict();
function deny(code:string,message:string,status=409):never{throw new PilotError(code,message,status);}
async function authorize(trx:Knex.Transaction,s:z.infer<typeof scope>,actor:number){
  if(!Number.isSafeInteger(actor)||actor<1)deny('PILOT_AUTH_REQUIRED','需要登录',401);
  if(!await trx('o_project').where({id:s.projectId,userId:actor}).first())deny('PILOT_FORBIDDEN','无权访问项目',403);
  if(!await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).first())deny('PILOT_SCOPE_INVALID','制作单元不存在',404);
}
async function imageBytes(projectId:number,source:any){
  const id=z.string().uuid().parse(source.attachmentId??source.artifactId);
  const parts=source.attachmentId?['v04-conversation',String(projectId),id+'.'+(source.mimeType==='image/jpeg'?'jpg':source.mimeType==='image/webp'?'webp':'png')]:
    ['v04-draft-artifacts',String(projectId),id+'.'+z.enum(['png','jpg','jpeg','webp']).parse(source.extension)];
  let bytes:Buffer;try{bytes=await fs.readFile(getPath(parts));}catch{deny('MULTIVIEW_SOURCE_NOT_READY','主参考图片不存在');}
  if(bytes.length>16*1024*1024||createHash('sha256').update(bytes).digest('hex')!==source.sourceHash)deny('MULTIVIEW_SOURCE_NOT_READY','参考图片内容已变化');
  return bytes;
}
export async function captureMultiViewSource(trx:Knex.Transaction,s:z.infer<typeof scope>){
  const state=await captureAutoAssetReadContext(trx,s),asset=resolveMultiViewBoy(state.assets);
  let source:any=null;
  // Current role heads are already resolved by baselinesInTransaction. Never
  // resurrect an older accepted baseline when the current one cannot be read.
  for(const role of ['FULL_BODY_FRONT','GENERAL']){
    const b=state.baselines.find(b=>b.canonicalKey===asset.canonicalKey&&b.role===role);
    if(!b)continue;
    const a=await trx('o_v04AgentAttachment').where({id:b.attachmentId,...s}).first();
    if(!a||a.sha256!==b.sha256||!a.messageId)deny('MULTIVIEW_SOURCE_NOT_READY','当前接受的参考绑定无效');
    if(b.sourceJobId){const job=state.jobs.find(j=>j.id===b.sourceJobId&&j.canonicalKey===asset.canonicalKey&&j.sourceAssetRevision===asset.revision);
      if(!job||job.status!=='SUCCEEDED')deny('MULTIVIEW_SOURCE_NOT_READY','接受的参考关联了失效草图任务');}
    source={type:'ACCEPTED_IDENTITY_BASELINE',sourceId:a.id,attachmentId:a.id,artifactId:b.sourceArtifactId??null,sourceHash:a.sha256,
      mimeType:a.mimeType,baselineVersion:b.version,role:b.role,assetRevision:asset.revision};break;
  }
  const spec=preparedSpec(state,asset,[]),confirmed=state.specs.find(r=>r.canonicalKey===asset.canonicalKey&&r.sourceAssetRevision===asset.revision);
  if(!source){
    const rejected=await trx('o_v04Decision').where({...s,category:'ASSET_IMAGE_EDIT',status:'REJECTED'}).limit(501);
    if(rejected.length>500)deny('MULTIVIEW_SOURCE_NOT_READY','候选历史超过安全上限');
    for(const job of state.jobs){
      if(job.canonicalKey!==asset.canonicalKey||job.sourceAssetRevision!==asset.revision||job.status!=='SUCCEEDED'||
        ![null,'SUBJECT_MAIN_PREVIEW','ASSET_MAIN_PREVIEW'].includes(job.executionPurpose??null)||rejected.some(r=>r.subjectKey===job.id))continue;
      const output=JSON.parse(job.outputsJson).find((o:any)=>o.role==='MAIN_PREVIEW');if(!output)continue;
      const snapshot=JSON.parse(job.inputSnapshotJson);
      if(!await autoJobFresh(job,trx,state))continue;
      if(!snapshot.autoVersion){
        if(!spec||!snapshot.visualSpecDraft||hash(spec)!==hash(snapshot.visualSpecDraft))continue;
        const c=await compileStudioDraftPromptsInTransaction(trx,{...s,items:[{canonicalKey:asset.canonicalKey,sourceAssetRevision:asset.revision,spec}]});
        if(c.failures.length||hash(c.candidates[0]?.draftPromptIR)!==hash(snapshot.draftPromptIR))continue;
      }
      const a=await trx('o_v04StudioDraftArtifact').where({artifactId:output.artifactId,jobId:job.id,projectId:s.projectId}).first();
      if(!a)deny('MULTIVIEW_SOURCE_NOT_READY','当前主视图文件记录缺失');
      let sourceBytes:Buffer;try{sourceBytes=await fs.readFile(getPath(['v04-draft-artifacts',String(s.projectId),z.string().uuid().parse(a.artifactId)+'.'+z.enum(['png','jpg','jpeg','webp']).parse(a.extension)]));}catch{deny('MULTIVIEW_SOURCE_NOT_READY','当前主视图文件不可读');}
      const sourceHash=createHash('sha256').update(sourceBytes).digest('hex');
      if(output.sha256&&output.sha256!==sourceHash)deny('MULTIVIEW_SOURCE_NOT_READY','主视图内容已变化');
      source={type:'FRESH_MAIN_PREVIEW',sourceId:a.artifactId,artifactId:a.artifactId,attachmentId:null,sourceHash,
        extension:a.extension,mimeType:a.mimeType,sourceJobId:job.id,sourceDraftHash:job.draftHash,baselineVersion:null,role:'MAIN_PREVIEW',assetRevision:asset.revision};break;
    }
  }
  if(!source)deny('MULTIVIEW_SOURCE_NOT_READY','没有当前可用的男孩主身份图，请先确认已有主参考');
  const bytes=await imageBytes(s.projectId,source);
  const meta=await sharp(bytes,{limitInputPixels:16000000}).metadata();
  if(!meta.width||!meta.height||(meta.pages??1)!==1)deny('MULTIVIEW_SOURCE_NOT_READY','参考图片格式无效');
  source={...source,width:meta.width,height:meta.height,visualSpecRevision:confirmed?.revision??null};
  let route:Awaited<ReturnType<typeof resolveEditRouting>>;
  try{route=await resolveEditRouting(trx,s.projectId,'DERIVE_VIEW');}catch(e){if(e instanceof PilotError)deny('MULTIVIEW_ROUTE_UNSUPPORTED','当前人物派生路由不可用');throw e;}
  if(route.profile!=='KREA2_DERIVE_CHARACTER_REFERENCE_V1')deny('MULTIVIEW_ROUTE_UNSUPPORTED','当前路由不支持人物身份参考派生');
  if(!state.config?.enabled)deny('MULTIVIEW_ROUTE_UNSUPPORTED','本地图片执行器未启用');
  const evidence={...s,asset,source,visualSpec:spec,visualSpecRevision:confirmed?.revision??null,
    route,baseUrl:localComfyOrigin(state.config.baseUrl),workflowVersion:KREA_EDIT_WORKFLOW_VERSION,compilerVersion:MULTIVIEW_VERSION};
  if(Buffer.byteLength(JSON.stringify(evidence))>250000)deny('MULTIVIEW_SOURCE_NOT_READY','身份证据超过安全上限');
  return {evidence,source,asset,sourceHash:hash(evidence)};
}
const present=(r:any)=>({...JSON.parse(r.compiledJson),status:r.status,execution:JSON.parse(r.executionJson),evaluation:r.evaluationJson?JSON.parse(r.evaluationJson):null,updatedAt:r.updatedAt});
async function checked(trx:Knex.Transaction,s:z.infer<typeof command>,actor:number){await authorize(trx,s,actor);const r=await trx(table).where({id:s.experimentId,projectId:s.projectId,scriptId:s.scriptId}).first();if(!r)deny('MULTIVIEW_NOT_FOUND','实验不存在',404);return r;}
async function fresh(trx:Knex.Transaction,r:any){try{return (await captureMultiViewSource(trx,{projectId:r.projectId,scriptId:r.scriptId})).sourceHash===JSON.parse(r.compiledJson).sourceHash;}catch(e){if(e instanceof PilotError)return false;throw e;}}
export async function compileMultiView(input:unknown,actor:number){
  const s=scope.parse(input);return q.transaction(async trx=>{
    await authorize(trx,s,actor);const c=await captureMultiViewSource(trx,s),id=randomUUID(),createdAt=Date.now();
    const seed=parseInt(c.sourceHash.slice(0,12),16),profile=c.evidence.route.profile;
    const make=(side:'SIDE'|'BACK')=>{const part=compileMultiViewBrief(c.asset,c.source,side),workflow=buildKreaEditWorkflow({profile,prompt:part.prompt,seed,width:768,height:768,sourceImage:'multiview-identity.png',jobId:id,targetRole:'EXPERIMENTAL_MULTIVIEW_'+side});return {...part,sourceHash:c.source.sourceHash,workflow};};
    const SIDE=make('SIDE'),BACK=make('BACK');
    const result={id,...s,canonicalKey:c.asset.canonicalKey,assetRevision:c.asset.revision,version:MULTIVIEW_VERSION,source:c.source,sourceHash:c.sourceHash,evidence:c.evidence,
      identityLock:{...SIDE.brief.sourceIdentity,preserve:SIDE.brief.preserve},topology:'STAR',anglePolicy:'TOLERANT',SIDE,BACK,
      sharedExecution:{profile,workflowVersion:KREA_EDIT_WORKFLOW_VERSION,seed,width:768,height:768,...graphFacts(SIDE.workflow.graph)},
      sourceQualityGate:'HUMAN_REVIEW_REQUIRED',fallback:{status:'NOT_AUTHORIZED',sources:['MAIN','HUMAN_PASSED_SIDE'],maxAttempts:1},createdAt};
    const frozen={...result,experimentHash:hash(result)};
    await trx(table).insert({id,...s,status:'COMPILED',compiledJson:JSON.stringify(frozen),executionJson:'{}',evaluationJson:null,createdAt,updatedAt:createdAt});
    return present({compiledJson:JSON.stringify(frozen),status:'COMPILED',executionJson:'{}',updatedAt:createdAt});
  });
}
export async function readMultiView(input:unknown,actor:number){const s=scope.parse(input);return q.transaction(async trx=>{await authorize(trx,s,actor);const rows=await trx(table).where(s).orderBy('createdAt','desc').orderBy('id','desc').limit(20);let current:string|null=null;
  try{if(rows.length)current=(await captureMultiViewSource(trx,s)).sourceHash;}catch(e){if(!(e instanceof PilotError))throw e;}
  return rows.map(r=>{const p=present(r);if(p.sourceHash!==current)p.status='STALE';return p;});});}
let rendering=false;
export async function renderMultiView(input:unknown,actor:number){
  const s=renderRequest.parse(input);const r=await q.transaction(async trx=>{
    await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).update({id:s.scriptId});
    const r=await checked(trx,s,actor),c=JSON.parse(r.compiledJson);
    if(c.experimentHash!==s.experimentHash)deny('MULTIVIEW_INPUT_CHANGED','编译输入不匹配');
    if(r.status!=='COMPILED')return {...r,replayed:true};
    if(!await fresh(trx,r))deny('MULTIVIEW_SOURCE_NOT_READY','身份参考或配置已变化，请重新编译');
    if(rendering||await trx(table).whereIn('status',['RENDERING_SIDE','RENDERING_BACK']).first()||
      await trx('o_v04StudioAssetDraftJob').whereIn('status',['QUEUED','RUNNING']).first()||
      await trx('o_v04DirectorAssetAB').whereIn('status',['RENDERING_A','RENDERING_A0','RENDERING_A1','RENDERING_B']).first())deny('MULTIVIEW_GPU_BUSY','已有实验图片任务，请等待完成');
    const execution={SIDE:{id:randomUUID(),status:'QUEUED'},BACK:{id:randomUUID(),status:'QUEUED'},sourceQualityConfirmed:true};
    await trx(table).where({id:r.id}).update({status:'RENDERING_SIDE',executionJson:JSON.stringify(execution),updatedAt:Date.now()});return {...r,status:'RENDERING_SIDE',executionJson:JSON.stringify(execution)};
  });
  if(!r.replayed){rendering=true;void run(r).finally(()=>{rendering=false;}).catch(()=>console.error('[V04 MultiView] settlement failed',{experimentId:r.id}));}return present(r);
}
async function run(r:any){
  const c=JSON.parse(r.compiledJson),e=JSON.parse(r.executionJson),base=c.evidence.baseUrl;let release:(()=>Promise<void>)|null=null;
  const save=(status:string)=>q(table).where({id:r.id}).update({status,executionJson:JSON.stringify(e),updatedAt:Date.now()});
  try{
    release=await acquireDraftWorkerLease(getPath(['v04-draft-worker.lock']));if(!release)throw new DraftComfyError('MULTIVIEW_GPU_BUSY','本地执行器忙');
    const qr=await fetch(base+'/queue',{redirect:'error',signal:AbortSignal.timeout(10000)});if(!qr.ok)throw new DraftComfyError('COMFY_OFFLINE','无法确认执行队列');
    const queue:any=await qr.json();if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||queue.queue_running.length||queue.queue_pending.length)throw new DraftComfyError('MULTIVIEW_GPU_BUSY','本地执行器忙');
    if(!await q.transaction(trx=>fresh(trx,r))){e.SIDE.status=e.BACK.status='NOT_RUN';await save('STALE');return;}
    const bytes=await imageBytes(r.projectId,c.source),png=await sharp(bytes).png().toBuffer();
    const sourceImage=await uploadEditInput(base,png,'mv-'+r.id+'.png');
    for(const side of multiViewSides){
      if(!await q.transaction(trx=>fresh(trx,r))){e[side].status='NOT_RUN';await save('STALE');return;}
      try{
        e[side].status='RUNNING';await save('RENDERING_'+side);
        const workflow=structuredClone(c[side].workflow);workflow.graph['7'].inputs.image=sourceImage;
        const job={id:e[side].id,projectId:r.projectId,scriptId:r.scriptId,canonicalKey:c.canonicalKey,sourceAssetRevision:c.assetRevision,
          generationIntent:'SUBJECT_MAIN_PREVIEW',executionPurpose:'EXPERIMENTAL_MULTIVIEW_'+side,executorType:'COMFY_LOCAL',executorProfile:c.sharedExecution.profile,
          inputSnapshotJson:JSON.stringify({sourceType:'MULTIVIEW_EXPERIMENT',sourceAssetRevision:c.assetRevision,sourceSha256:c.source.sourceHash,
            sourceAttachmentId:c.source.attachmentId,sourceArtifactId:c.source.artifactId,sourceJobId:c.source.sourceJobId??null,baselineVersion:c.source.baselineVersion})};
        const promptId=await submitTracedDraft(base,workflow,job);e[side].promptId=promptId;await save('RENDERING_'+side);
        const image=await downloadDraft(base,await awaitDraft(base,promptId,workflow.outputNode,900000));
        if(image.width!==c.sharedExecution.width||image.height!==c.sharedExecution.height)throw new DraftComfyError('MULTIVIEW_OUTPUT_INVALID','输出尺寸偏离冻结条件');
        const artifact={artifactId:randomUUID(),role:'EXPERIMENTAL_MULTIVIEW_'+side,width:image.width,height:image.height,extension:image.extension,mimeType:image.mimeType,sha256:createHash('sha256').update(image.bytes).digest('hex')};
        const dir=getPath(['v04-multiview',String(r.projectId),r.id]);await fs.mkdir(dir,{recursive:true});await fs.writeFile(getPath(['v04-multiview',String(r.projectId),r.id,artifact.artifactId+'.'+artifact.extension]),image.bytes,{flag:'wx'});
        e[side]={...e[side],status:'SUCCEEDED',artifact};
        await q('o_v04ExecutionTrace').where({jobId:job.id,status:'RUNNING'}).update({status:'SUCCEEDED',outputArtifactIdsJson:JSON.stringify([artifact.artifactId]),completedAt:Date.now(),updatedAt:Date.now()});
      }catch(error){const code=error instanceof DraftComfyError?error.code:'EXECUTION_UNCERTAIN';e[side]={...e[side],status:'FAILED',errorCode:code};
        await q('o_v04ExecutionTrace').where({jobId:e[side].id}).whereIn('status',['QUEUED','RUNNING']).update({status:'FAILED',errorCode:code,errorDetail:code,completedAt:Date.now(),updatedAt:Date.now()});}
      await save('RENDERING_'+side);
      // A failed Side may leave a GPU prompt unresolved. Never start another
      // prompt on that uncertainty, or silently retry the failed view.
      if(e[side].status==='FAILED'){if(side==='SIDE')e.BACK.status='NOT_RUN';break;}
    }
    e.completedAt=Date.now();await save(!await q.transaction(trx=>fresh(trx,r))?'STALE':multiViewSides.every(side=>e[side].status==='SUCCEEDED')?'COMPLETED':multiViewSides.some(side=>e[side].status==='SUCCEEDED')?'PARTIAL':'FAILED');
  }catch(error){e.errorCode=error instanceof DraftComfyError?error.code:'EXECUTION_UNCERTAIN';for(const side of multiViewSides)if(e[side].status==='QUEUED')e[side].status='NOT_RUN';await save('FAILED');}
  finally{if(release)await release();}
}
export async function evaluateMultiView(input:unknown,actor:number){
  const verdict=z.enum(['PASS','PARTIAL_PASS','FAIL']),s=command.extend({SIDE:verdict,BACK:verdict,why:z.string().max(4000).default('')}).strict().parse(input);
  return q.transaction(async trx=>{await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).update({id:s.scriptId});const r=await checked(trx,s,actor);
    if(!['COMPLETED','PARTIAL'].includes(r.status)||!await fresh(trx,r))deny('MULTIVIEW_SOURCE_NOT_READY','只能评价当前已完成的实验结果');
    const e=JSON.parse(r.executionJson);for(const side of multiViewSides)if(e[side]?.status!=='SUCCEEDED'&&s[side]!=='FAIL')deny('MULTIVIEW_INPUT_CHANGED','未完成视角只能记录 FAIL');
    const result={SIDE:s.SIDE,BACK:s.BACK,why:s.why,actorUserId:actor,createdAt:Date.now()};await trx(table).where({id:r.id}).update({evaluationJson:JSON.stringify(result),updatedAt:Date.now()});return result;});
}
export async function multiViewArtifact(input:unknown,actor:number){
  const s=command.extend({side:z.enum(['MAIN','SIDE','BACK'])}).strict().parse(input);
  const c=await q.transaction(async trx=>{const r=await checked(trx,s,actor);return {compiled:JSON.parse(r.compiledJson),execution:JSON.parse(r.executionJson)};});
  if(s.side==='MAIN')return {bytes:await imageBytes(s.projectId,c.compiled.source),mimeType:c.compiled.source.mimeType};
  const a=c.execution[s.side]?.artifact;if(!a)deny('MULTIVIEW_ARTIFACT_MISSING','该视角还没有图片',404);
  const bytes=await fs.readFile(getPath(['v04-multiview',String(s.projectId),s.experimentId,z.string().uuid().parse(a.artifactId)+'.'+z.enum(['png','jpg','jpeg','webp']).parse(a.extension)]));
  if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)deny('MULTIVIEW_ARTIFACT_MISSING','图片校验失败',404);return {bytes,mimeType:a.mimeType};
}

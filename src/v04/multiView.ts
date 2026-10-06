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
import {integrityProfiles,inspection,repairDecision,makeRepairProposals,integrityFresh} from './assetIntegrity';
import {resolveIntegrityProfile,integritySemanticContext} from './integrityProfileResolver';
import {INTEGRITY_TABLE} from './integritySchema';
import {buildGenerationStructuralGuard,GENERATION_GUARD_VERSION} from './generationStructuralGuard';
import {fastIntegrityGate,FAST_GATE_VERSION,requiredVisualChecks} from './fastIntegrityGate';
import {integrityDecision,DECISION_ENGINE_VERSION,retryPolicy} from './integrityDecisionEngine';
import {prepareIntegrityVision,inspectIntegrityVision,VISION_INTEGRITY_VERSION} from './visionIntegrityAdapter';
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
    const make=(side:'SIDE'|'BACK')=>{const part=compileMultiViewBrief(c.asset,c.source,side),resolution=resolveIntegrityProfile(integritySemanticContext(c.asset,c.evidence.visualSpec));
      const generationGuard=buildGenerationStructuralGuard({profile:resolution.profile,targetView:side,identityAuthority:'CURRENT_REFERENCE_IMAGE',sourceDimensions:{width:c.source.width,height:c.source.height},confirmedCounts:[],identityAnchors:c.asset.identityAnchors,mustPreserve:part.brief.preserve,forbiddenChanges:part.brief.sourceIdentity.forbiddenChanges,confirmedMorphology:c.evidence.visualSpec?.details??null});
      const prompt=part.prompt+' '+generationGuard.constraints.join(' '),workflow=buildKreaEditWorkflow({profile,prompt,seed,width:768,height:768,sourceImage:'multiview-identity.png',jobId:id,targetRole:'EXPERIMENTAL_MULTIVIEW_'+side});return {...part,basePrompt:part.prompt,basePromptHash:part.promptHash,prompt,promptHash:hash(prompt),generationGuard,sourceHash:c.source.sourceHash,workflow};};
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
  if(!r.replayed){rendering=true;void run(r,actor).finally(()=>{rendering=false;}).catch(()=>console.error('[V04 MultiView] settlement failed',{experimentId:r.id}));}return present(r);
}
async function run(r:any,actor:number){
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
        e[side].status='RUNNING';e[side].generationStartedAt=Date.now();await save('RENDERING_'+side);
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
        e[side]={...e[side],status:'SUCCEEDED',artifact,generationTimeMs:Date.now()-e[side].generationStartedAt};
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
  try{await fastMultiViewQuality({projectId:r.projectId,scriptId:r.scriptId,experimentId:r.id},actor);}catch{console.error('[V04 Integrity]',{experimentId:r.id,status:'FAST_UNAVAILABLE'});}
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

async function integrityInput(trx:Knex.Transaction,r:any){
 const c=JSON.parse(r.compiledJson),e=JSON.parse(r.executionJson);
 if(!await fresh(trx,r))deny('INTEGRITY_INPUT_STALE','资产或来源已变化');
 if(!['COMPLETED','PARTIAL'].includes(r.status)||!['SIDE','BACK'].every(v=>e[v]?.status==='SUCCEEDED'&&e[v]?.artifact?.sha256))deny('INTEGRITY_NOT_READY','需要已完成的 MAIN/SIDE/BACK 图像');
 for(const side of ['MAIN','SIDE','BACK']){
  const a=side==='MAIN'?c.source:e[side].artifact;
  const bytes=side==='MAIN'?await imageBytes(r.projectId,a):await fs.readFile(getPath(['v04-multiview',String(r.projectId),r.id,z.string().uuid().parse(a.artifactId)+'.'+z.enum(['png','jpg','jpeg','webp']).parse(a.extension)]));
  if(createHash('sha256').update(bytes).digest('hex')!==(side==='MAIN'?a.sourceHash:a.sha256))deny('INTEGRITY_INPUT_STALE','图像内容已变化');
 }
 return {experimentId:r.id,sourceHash:c.sourceHash,assetRevision:c.assetRevision,visualSpecRevision:c.source.visualSpecRevision??null,artifacts:{MAIN:c.source.sourceHash,SIDE:e.SIDE.artifact.sha256,BACK:e.BACK.artifact.sha256}};
}
function multiViewIntegrityContext(c:any){
 const resolution=resolveIntegrityProfile(integritySemanticContext(c.evidence.asset,c.evidence.visualSpec));
 return {canonicalKey:c.canonicalKey,assetKind:c.evidence.asset.assetKind,integrityProfile:resolution.profile,profileResolverVersion:resolution.version,profileResolution:resolution,identityAuthority:c.identityLock.identityAuthority,identityAnchors:c.identityLock.identityAnchors,mustPreserve:c.identityLock.preserve,forbiddenChanges:c.identityLock.forbiddenChanges,confirmedParts:[],expectedPartCounts:[],allowedAsymmetry:[],confirmedVisualSpec:c.evidence.visualSpec??null,currentView:['MAIN','SIDE','BACK'],referenceViews:['MAIN'],sourceHash:c.sourceHash,assetRevision:c.assetRevision,visualSpecRevision:c.source.visualSpecRevision??null,knowledgePolicy:'Confirmed fictional structure overrides priors. Not visible is not missing. No Director mood judgement.'};
}
export async function readMultiViewIntegrity(input:unknown,actor:number){const s=command.parse(input);return q.transaction(async trx=>{
 const r=await checked(trx,s,actor),c=JSON.parse(r.compiledJson);let captured:any=null;try{captured=await integrityInput(trx,r);}catch(e){if(!(e instanceof PilotError))throw e;}
 const context=multiViewIntegrityContext(c),profile=integrityProfiles[context.integrityProfile];
 const history=await trx(INTEGRITY_TABLE).where(s).orderBy('createdAt','desc').orderBy('id','desc').limit(100);
 return {input:captured,context,profile,inspector:'HUMAN_INSPECTOR',automaticVision:false,history:history.map(row=>({id:row.id,createdAt:row.createdAt,actorUserId:row.actorUserId,input:JSON.parse(row.inputJson),...JSON.parse(row.reportJson),freshness:captured&&integrityFresh(JSON.parse(row.inputJson),captured)?'CURRENT':'STALE'}))};
 }).then(async result=>{
 const humans=result.history.filter((r:any)=>r.inspector==='HUMAN_INSPECTOR'&&r.freshness==='CURRENT');
 for(const row of result.history as any[])if(row.pipeline?.fast){row.effectiveFast=Object.fromEntries(['SIDE','BACK'].map(view=>[view,fastAuthority(row.pipeline.fast[view],result.context.integrityProfile,view,row.freshness==='CURRENT'?humans.find((h:any)=>h.reports?.[view]?.reviewed)?.decisions[view]:undefined)]));row.effectiveDecisions=Object.fromEntries(Object.entries(row.effectiveFast).map(([view,f])=>[view,integrityDecision(f).result]));}
 return {...result,externalVision:await readVisionCapability(s.projectId)};
 });}
export async function recordMultiViewIntegrity(input:unknown,actor:number){
 const s=command.extend({expectedInput:z.object({experimentId:z.string().uuid(),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),assetRevision:z.number().int().positive(),visualSpecRevision:z.number().int().positive().nullable(),artifacts:z.object({MAIN:z.string().regex(/^[a-f0-9]{64}$/),SIDE:z.string().regex(/^[a-f0-9]{64}$/),BACK:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict(),reports:z.object({SIDE:inspection,BACK:inspection,CROSS_VIEW:inspection}).strict()}).strict().parse(input);
 return q.transaction(async trx=>{await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).update({id:s.scriptId});const r=await checked(trx,s,actor),captured=await integrityInput(trx,r);
 if(!integrityFresh(s.expectedInput,captured))deny('INTEGRITY_INPUT_STALE','检查对象已变化，请刷新');
 for(const [view,report] of Object.entries(s.reports))for(const issue of report.issues){if(view!=='CROSS_VIEW'&&!issue.evidenceViews.includes(view as 'SIDE'|'BACK'))deny('INTEGRITY_EVIDENCE_INVALID','问题需关联当前视角');if(view==='CROSS_VIEW'&&(issue.category!=='CROSS_VIEW'||new Set(issue.evidenceViews).size<2))deny('INTEGRITY_EVIDENCE_INVALID','跨视图问题需要至少两个视角');}
 const ids=Object.values(s.reports).flatMap(report=>report.issues.map(issue=>issue.id));if(new Set(ids).size!==ids.length)deny('INTEGRITY_EVIDENCE_INVALID','问题标识不能重复');
 const c=JSON.parse(r.compiledJson),result={inspector:'HUMAN_INSPECTOR',context:multiViewIntegrityContext(c),reports:s.reports,decisions:Object.fromEntries(Object.entries(s.reports).map(([view,report])=>[view,repairDecision(report)])),repairProposals:makeRepairProposals(s.reports,captured,c.identityLock),automaticAcceptance:false};
 const id=randomUUID(),createdAt=Date.now();await trx(INTEGRITY_TABLE).insert({id,experimentId:r.id,projectId:s.projectId,scriptId:s.scriptId,inputJson:JSON.stringify(captured),reportJson:JSON.stringify(result),actorUserId:actor,createdAt});return {id,...result,freshness:'CURRENT'};
 });}

import {inspectionDerivatives,probeVisionCapability} from './visionCapability';
import {fastAuthority} from './integrityDecisionEngine';
import {integrityVisionConfiguration,minimalEscalationBrief} from './visionIntegrityAdapter';
import {createLocalFastVisionAdapter} from './localFastVision';
const PIPELINE_VERSION='integrity.pipeline.1';
const emptyInspection=()=>({reviewed:false,identity:'UNKNOWN',view:'UNKNOWN',contamination:'UNKNOWN',issues:[]});
function qualityBinding(c:any,e:any){return {experimentId:c.id,sourceHash:c.sourceHash,assetRevision:c.assetRevision,visualSpecRevision:c.source.visualSpecRevision??null,artifacts:{MAIN:c.source.sourceHash,SIDE:e.SIDE?.artifact?.sha256??null,BACK:e.BACK?.artifact?.sha256??null}};}
async function captureQuality(trx:Knex.Transaction,s:z.infer<typeof command>,actor:number){
 const r=await checked(trx,s,actor),c=JSON.parse(r.compiledJson),e=JSON.parse(r.executionJson),current=await fresh(trx,r),context=multiViewIntegrityContext(c);
 const images:{view:string;bytes:Buffer;mimeType:string}[]=[],dimensions:Record<string,unknown>={},metadata:Record<string,{name:string;pass:boolean}[]>={SIDE:[],BACK:[]};let totalBytes=0;
 for(const view of ['MAIN','SIDE','BACK']){
  let verified=false,size=false;try{const a=view==='MAIN'?c.source:e[view]?.artifact;if(!a)throw Error('MISSING');
   const artifactPath=view==='MAIN'?null:getPath(['v04-multiview',String(r.projectId),r.id,z.string().uuid().parse(a.artifactId)+'.'+z.enum(['png','jpg','jpeg','webp']).parse(a.extension)]);
   if(artifactPath&&(await fs.stat(artifactPath)).size>6000000)throw Error('SIZE');
   const bytes=artifactPath?await fs.readFile(artifactPath):await imageBytes(r.projectId,a);
   totalBytes+=bytes.length;if(bytes.length>6000000||totalBytes>15000000)throw Error('SIZE');
   verified=createHash('sha256').update(bytes).digest('hex')===(view==='MAIN'?a.sourceHash:a.sha256);
   const meta=await sharp(bytes,{limitInputPixels:16000000}).metadata();dimensions[view]={width:meta.width,height:meta.height};size=meta.width===(view==='MAIN'?c.source.width:c.sharedExecution.width)&&meta.height===(view==='MAIN'?c.source.height:c.sharedExecution.height)&&(meta.pages??1)===1;
   if(verified&&size)images.push({view,bytes,mimeType:meta.format==='jpeg'?'image/jpeg':meta.format==='webp'?'image/webp':'image/png'});
  }catch{/* Unreadable or unbounded image is an explicit metadata failure, never PASS. */}
  for(const side of ['SIDE','BACK'])if(view==='MAIN'||view===side)metadata[side].push({name:view+'_ARTIFACT_HASH',pass:verified},{name:view+'_DIMENSIONS',pass:size});
 }
 for(const side of ['SIDE','BACK'])metadata[side].push({name:'SOURCE_FRESHNESS',pass:current},{name:'SUCCEEDED_SINGLE_OUTPUT',pass:e[side]?.status==='SUCCEEDED'&&!!e[side]?.artifact},{name:'TARGET_VIEW_METADATA',pass:c[side]?.brief?.targetView===(side==='SIDE'?'SIDE_ISH':'BACK_ISH')});
 return {r,c,e,context,images,metadata,dimensions,binding:qualityBinding(c,e)};
}
function qualityBrief(x:Awaited<ReturnType<typeof captureQuality>>,fast:any,target:'SIDE'|'BACK'|'ALL'){
 if(target!=='ALL')return minimalEscalationBrief(x.context,fast,target);
 return {version:'integrity.fine-brief.1',assetProfile:x.context.integrityProfile,MAIN:'identity reference',target:'ALL',targets:{SIDE:minimalEscalationBrief(x.context,fast,'SIDE'),BACK:minimalEscalationBrief(x.context,fast,'BACK')}};
}
async function appendQuality(trx:Knex.Transaction,s:z.infer<typeof command>,actor:number,x:Awaited<ReturnType<typeof captureQuality>>,pipeline:any,reports:any){
 const id=randomUUID(),createdAt=Date.now(),result={inspector:'SHADOW_PIPELINE',context:x.context,reports,decisions:pipeline.decisions,repairProposals:makeRepairProposals(reports,x.binding,x.c.identityLock),automaticAcceptance:false,pipeline};
 await trx(INTEGRITY_TABLE).insert({id,...s,inputJson:JSON.stringify(x.binding),reportJson:JSON.stringify(result),actorUserId:actor,createdAt});return {id,createdAt,input:x.binding,...result};
}
export async function fastMultiViewQuality(input:unknown,actor:number){
 const s=command.parse(input),x=await q.transaction(trx=>captureQuality(trx,s,actor)),fast:any={};
 for(const view of ['SIDE','BACK'])fast[view]=await fastIntegrityGate(x.metadata[view],{profile:x.context.integrityProfile,view,questions:requiredVisualChecks,mustPreserve:x.context.mustPreserve,confirmedPhysicalFacts:x.context.confirmedVisualSpec?.details??null},createLocalFastVisionAdapter(x.images));
 const decisions=Object.fromEntries(Object.entries(fast).map(([view,f])=>[view,integrityDecision(f).result]));decisions.CROSS_VIEW='HUMAN_REVIEW';
 const pipeline={version:PIPELINE_VERSION,kind:'FAST',phase:'COMPLETED',guardVersion:x.c.SIDE.generationGuard?.version??null,guardState:x.c.SIDE.generationGuard?'APPLIED':'NOT_APPLICABLE_HISTORICAL',profileResolverVersion:x.context.profileResolverVersion,actualDimensions:x.dimensions,generationTimeMs:Object.fromEntries(['SIDE','BACK'].map(view=>[view,x.e[view]?.generationTimeMs??null])),fastGateVersion:FAST_GATE_VERSION,visionAdapterVersion:VISION_INTEGRITY_VERSION,decisionEngineVersion:DECISION_ENGINE_VERSION,fast,visionEscalation:'NOT_REQUESTED',decisions,decisionAuthority:Object.fromEntries(Object.entries(fast).map(([view,f])=>[view,integrityDecision(f).decisionAuthority])),retryPolicy,metrics:{fastPassCount:Object.values(fast).filter((f:any)=>f.status==='PASS').length,fastClearFailCount:Object.values(fast).filter((f:any)=>f.status.startsWith('CLEAR_')).length,apiEscalationCount:0,apiEscalationRate:0,fastClearLocalCount:Object.values(fast).filter((f:any)=>f.status==='CLEAR_LOCAL_DEFECT').length,fastClearGlobalCount:Object.values(fast).filter((f:any)=>f.status==='CLEAR_GLOBAL_DEFECT').length,fastSuspectCount:Object.values(fast).filter((f:any)=>f.status.startsWith('SUSPECT')).length,fastUnavailableCount:Object.values(fast).filter((f:any)=>f.status==='UNAVAILABLE').length,averageFastLatency:Object.values(fast).reduce((n:number,f:any)=>n+f.latencyMs,0)/2},shadowMode:true};
 return q.transaction(async trx=>{await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).update({id:s.scriptId});const now=await captureQuality(trx,s,actor);if(!integrityFresh(x.binding,now.binding)||JSON.stringify(x.metadata)!==JSON.stringify(now.metadata))deny('INTEGRITY_INPUT_STALE','检查输入已变化');return appendQuality(trx,s,actor,x,pipeline,{SIDE:emptyInspection(),BACK:emptyInspection(),CROSS_VIEW:emptyInspection()});});
}
export async function visionMultiViewQuality(input:unknown,actor:number){
 const s=command.extend({fastReportId:z.string().uuid(),confirmExternalInspection:z.literal(true),targetView:z.enum(['SIDE','BACK','ALL']).default('ALL'),forceShadow:z.boolean().default(false)}).strict().parse(input),cmd={projectId:s.projectId,scriptId:s.scriptId,experimentId:s.experimentId};
 await q.transaction(trx=>checked(trx,cmd,actor));const prepared=await prepareIntegrityVision(s.projectId);
 const admitted=await q.transaction(async trx=>{await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).update({id:s.scriptId});const x=await captureQuality(trx,cmd,actor);
  const prior=await trx(INTEGRITY_TABLE).where({...cmd,id:s.fastReportId}).first();if(!prior)deny('INTEGRITY_NOT_FOUND','Fast 检查不存在');const parent=JSON.parse(prior.reportJson).pipeline;
  if(parent?.kind!=='FAST'||!integrityFresh(JSON.parse(prior.inputJson),x.binding))deny('INTEGRITY_INPUT_STALE','Fast 检查已过期');
  const humanRows=await trx(INTEGRITY_TABLE).where(cmd).whereRaw("json_extract(reportJson,'$.inspector')='HUMAN_INSPECTOR'").orderBy('createdAt','desc').orderBy('id','desc').limit(100);
  const human=humanRows.filter(row=>integrityFresh(JSON.parse(row.inputJson),x.binding)).map(row=>JSON.parse(row.reportJson));
  parent.fast=Object.fromEntries(['SIDE','BACK'].map(view=>[view,fastAuthority(parent.fast[view],x.context.integrityProfile,view,human.find(r=>r.reports?.[view]?.reviewed)?.decisions[view])]));
  const targets=s.targetView==='ALL'?['SIDE','BACK']:[s.targetView];
  if(!s.forceShadow&&!targets.some(view=>parent.fast[view].escalationRequired))deny('INTEGRITY_ESCALATION_NOT_NEEDED','已有验证范围内的结论；Professional 可显式请求影子复核');
  const inspectionKey=createHash('sha256').update(JSON.stringify({binding:x.binding,targetView:s.targetView,configSignature:prepared.signature,briefVersion:'integrity.shadow-brief.3'})).digest('hex');
  if(x.images.length!==3||Object.values(x.metadata).some(checks=>checks.some(c=>!c.pass)))deny('INTEGRITY_INPUT_STALE','图像或来源无法可靠核对，不发送 API');
  const replay=await trx(INTEGRITY_TABLE).where(cmd).whereRaw("json_extract(reportJson,'$.pipeline.inspectionKey') = ? AND json_extract(reportJson,'$.pipeline.kind') = 'VISION'",[inspectionKey]).orderByRaw("CASE WHEN json_extract(reportJson,'$.pipeline.phase')='COMPLETED' THEN 0 ELSE 1 END").orderBy('createdAt','desc').orderBy('id','desc').first();
  if(replay)return {replay:{id:replay.id,...JSON.parse(replay.reportJson)},x,parent,capability:null};
  const capabilityRow=await trx(INTEGRITY_TABLE).where({projectId:s.projectId}).whereRaw("json_extract(reportJson,'$.pipeline.kind') = 'PREFLIGHT' AND json_extract(reportJson,'$.pipeline.configSignature') = ? AND json_extract(reportJson,'$.pipeline.phase') = 'COMPLETED' AND json_extract(reportJson,'$.pipeline.capability.state')='INTEGRITY_VISION_READY'",[prepared.signature]).orderBy('createdAt','desc').orderBy('id','desc').first();
  const capability=capabilityRow?JSON.parse(capabilityRow.reportJson).pipeline.capability:null;
  if(capability?.state!=='INTEGRITY_VISION_READY')deny('INTEGRITY_VISION_PREFLIGHT_REQUIRED','请先完成该视觉配置的能力预检；不会直接发送完整检查');
  const started=await appendQuality(trx,cmd,actor,x,{...parent,kind:'VISION',phase:'STARTED',inspectionKey,forceShadow:s.forceShadow,targetView:s.targetView,configSignature:prepared.signature,fastReportId:s.fastReportId,visionEscalation:'STARTED',decisions:{SIDE:'HUMAN_REVIEW',BACK:'HUMAN_REVIEW',CROSS_VIEW:'HUMAN_REVIEW'},shadowMode:true},{SIDE:emptyInspection(),BACK:emptyInspection(),CROSS_VIEW:emptyInspection()});return {x,parent,started,capability,inspectionKey};
 });if(admitted.replay)return admitted.replay;
 const brief=qualityBrief(admitted.x,admitted.parent.fast,s.targetView),vision=await inspectIntegrityVision(s.projectId,brief,admitted.x.images,{prepared,transportMode:admitted.capability.transportMode,targetView:s.targetView}),reports={SIDE:emptyInspection(),BACK:emptyInspection(),CROSS_VIEW:emptyInspection(),...vision.reports};
 const decisions:any={},authority:any={};for(const view of ['SIDE','BACK']){const d=integrityDecision(admitted.parent.fast[view],vision.reports?.[view]?{confidence:vision.reports[view].confidence,report:vision.reports[view]}:null);decisions[view]=d.result;authority[view]=d.decisionAuthority;}decisions.CROSS_VIEW=vision.reports?.CROSS_VIEW?.confidence==='HIGH'?repairDecision(vision.reports.CROSS_VIEW):'HUMAN_REVIEW';authority.CROSS_VIEW=vision.reports?'VISION_API':'HUMAN';
 return q.transaction(async trx=>{await checked(trx,cmd,actor);const now=await captureQuality(trx,cmd,actor),current=integrityFresh(now.binding,admitted.x.binding)&&Object.values(now.metadata).every(checks=>checks.every(c=>c.pass));if(!current)for(const view of Object.keys(decisions))decisions[view]='HUMAN_REVIEW';
  return appendQuality(trx,cmd,actor,admitted.x,{...admitted.parent,kind:'VISION',phase:'COMPLETED',inspectionKey:admitted.inspectionKey,forceShadow:s.forceShadow,targetView:s.targetView,configSignature:prepared.signature,fastReportId:s.fastReportId,visionEscalation:vision.status==='SUCCEEDED'?'USED':'FAILED',visionAudit:vision.audit,inspectionBrief:brief,decisions,decisionAuthority:authority,freshness:current?'CURRENT':'STALE',metrics:{...admitted.parent.metrics,apiEscalationCount:1,apiEscalationRate:1},guardFeedback:{version:'generation.guard-feedback.1',proposalOnly:true,promotionAuthorized:false,issueIds:Object.values(reports).flatMap(r=>r.issues.map((i:any)=>i.id))},shadowMode:true},reports);});
}

export async function feedbackMultiViewQuality(input:unknown,actor:number){
 const s=command.extend({visionReportId:z.string().uuid(),usefulness:z.enum(['USEFUL','PARTIALLY_USEFUL','WRONG'])}).strict().parse(input),cmd={projectId:s.projectId,scriptId:s.scriptId,experimentId:s.experimentId};
 return q.transaction(async trx=>{const x=await captureQuality(trx,cmd,actor),row=await trx(INTEGRITY_TABLE).where({...cmd,id:s.visionReportId}).first();if(!row)deny('INTEGRITY_NOT_FOUND','检查记录不存在');const report=JSON.parse(row.reportJson);
 if(report.pipeline?.kind!=='VISION'||report.pipeline.phase!=='COMPLETED'||!integrityFresh(JSON.parse(row.inputJson),x.binding))deny('INTEGRITY_INPUT_STALE','只评价当前已完成的 Vision 影子检查');
 return appendQuality(trx,cmd,actor,x,{...report.pipeline,kind:'HUMAN_FEEDBACK',visionReportId:s.visionReportId,humanFeedback:s.usefulness},report.reports);});
}

export async function readVisionCapability(projectId:number){
 try{const config=await integrityVisionConfiguration(projectId),row=await q(INTEGRITY_TABLE).where({projectId}).whereRaw("json_extract(reportJson,'$.pipeline.kind')='PREFLIGHT' AND json_extract(reportJson,'$.pipeline.configSignature')=?",[config.signature]).orderByRaw("CASE WHEN json_extract(reportJson,'$.pipeline.capability.state')='INTEGRITY_VISION_READY' THEN 0 WHEN json_extract(reportJson,'$.pipeline.phase')='COMPLETED' THEN 1 ELSE 2 END").orderBy('createdAt','desc').orderBy('id','desc').first();
 const pipeline=row?JSON.parse(row.reportJson).pipeline:null,prior=!row&&await q(INTEGRITY_TABLE).where({projectId}).whereRaw("json_extract(reportJson,'$.pipeline.kind')='PREFLIGHT'").first();
 return {configured:true,model:config.model,configSignature:config.signature,state:pipeline?.capability?.state==='INTEGRITY_VISION_READY'?'READY':pipeline?.phase==='STARTED'?'PENDING':pipeline?'FAILED':prior?'STALE':'UNKNOWN',capability:pipeline?.capability??null};
 }catch{return {configured:false,state:'UNAVAILABLE',capability:null};}
}
export async function preflightMultiViewVision(input:unknown,actor:number){
 const s=command.extend({fastReportId:z.string().uuid().optional(),confirmExternalInspection:z.literal(true),transportMode:z.enum(['NATIVE','JSON_TEXT']).default('NATIVE')}).strict().parse(input),cmd={projectId:s.projectId,scriptId:s.scriptId,experimentId:s.experimentId};
 // Verify project access before resolving any model configuration.
 await q.transaction(trx=>checked(trx,cmd,actor));const prepared=await prepareIntegrityVision(s.projectId);
 const admitted=await q.transaction(async trx=>{await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).update({id:s.scriptId});const x=await captureQuality(trx,cmd,actor),parent={decisions:{SIDE:'HUMAN_REVIEW',BACK:'HUMAN_REVIEW',CROSS_VIEW:'HUMAN_REVIEW'},shadowMode:true};
 if(x.images.length!==3||Object.values(x.metadata).some(checks=>checks.some(c=>!c.pass)))deny('INTEGRITY_INPUT_STALE','预检需要完整当前图像，不依赖 Fast 结论');
 const replay=await trx(INTEGRITY_TABLE).where({projectId:s.projectId}).whereRaw("json_extract(reportJson,'$.pipeline.kind')='PREFLIGHT' AND json_extract(reportJson,'$.pipeline.configSignature')=? AND json_extract(reportJson,'$.pipeline.transportMode')=?",[prepared.signature,s.transportMode]).orderByRaw("CASE WHEN json_extract(reportJson,'$.pipeline.phase')='COMPLETED' THEN 0 ELSE 1 END").orderBy('createdAt','desc').orderBy('id','desc').first();if(replay)return {replay:{id:replay.id,...JSON.parse(replay.reportJson)},x,parent};
 const started=await appendQuality(trx,cmd,actor,x,{...parent,kind:'PREFLIGHT',phase:'STARTED',fastReportId:s.fastReportId,configSignature:prepared.signature,transportMode:s.transportMode,visionEscalation:'PREFLIGHT_STARTED'}, {SIDE:emptyInspection(),BACK:emptyInspection(),CROSS_VIEW:emptyInspection()});return {x,parent,started};});if(admitted.replay)return admitted.replay;
 const images=await inspectionDerivatives(admitted.x.images),capability=await probeVisionCapability(prepared.session,images,s.transportMode),[providerId,modelName]=prepared.model.split(/:(.+)/);
 return q.transaction(async trx=>{await checked(trx,cmd,actor);return appendQuality(trx,cmd,actor,admitted.x,{...admitted.parent,kind:'PREFLIGHT',phase:'COMPLETED',fastReportId:s.fastReportId,configSignature:prepared.signature,transportMode:s.transportMode,visionEscalation:'PREFLIGHT_COMPLETED',capability:{...capability,providerId:providerId.replace(/[^\w.-]/g,'').slice(0,80),modelName:modelName.replace(/[^\w.\/-]/g,'').slice(0,120),derivatives:images.map(i=>i.audit)}},{SIDE:emptyInspection(),BACK:emptyInspection(),CROSS_VIEW:emptyInspection()});});
}

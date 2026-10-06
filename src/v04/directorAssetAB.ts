import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import type {Knex} from 'knex';
import {z} from 'zod';
import {db} from '@/utils/db';
import getPath from '@/utils/getPath';
import {PilotError} from './service';
import {captureCurrentDirectorForExperiment} from './directorBible';
import {captureAutoAssetReadContext,preparedSpec} from './autoAsset';
import {compileStudioDraftPromptsInTransaction} from './visualSpec';
import {resolveEditRouting} from './operations';
import {autoAssetResolution,AUTO_ASSET_RECONCILER_V1,KREA2_ASSET_T2I_RENDERING_V1} from './autoAssetPrompt';
import {buildKreaEditWorkflow,KREA_EDIT_WORKFLOW_VERSION} from './kreaImageEditProfile';
import {graphFacts} from './operationsRegistry';
import {localComfyOrigin,awaitDraft,downloadDraft,DraftComfyError} from './comfyDraftClient';
import {submitTracedDraft} from './tracedDraftSubmit';
import {acquireDraftWorkerLease} from './draftWorkerLease';
import {abHash,compileDirectorABAssetInput,DIRECTOR_AB_COMPILER} from './directorAssetABCompiler';
const q=db as Knex, table='o_v04DirectorAssetAB';
const scope=z.object({projectId:z.number().int().positive(),scriptId:z.number().int().positive()}).strict();
const command=scope.extend({experimentId:z.string().uuid()}).strict();
const renderRequest=command.extend({pairHash:z.string().regex(/^[a-f0-9]{64}$/),confirmRender:z.literal(true)}).strict();
const evaluationRequest=command.extend({choices:z.array(z.enum(['A','B','Same'])).length(6),
  conclusion:z.enum(['CLEAR_WIN','PARTIAL_WIN','NO_IMPROVEMENT','REGRESSION']),why:z.string().max(4000).default('')}).strict();
function deny(code:string,message:string,status=409):never{throw new PilotError(code,message,status);}
async function authorize(trx:Knex.Transaction,s:z.infer<typeof scope>,actor:number){
  if(!Number.isSafeInteger(actor)||actor<1)deny('PILOT_AUTH_REQUIRED','需要登录',401);
  if(!await trx('o_project').where({id:s.projectId,userId:actor}).first())deny('PILOT_FORBIDDEN','无权访问项目',403);
  if(!await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).first())deny('PILOT_SCOPE_INVALID','制作单元不存在',404);
}
export async function captureDirectorABSource(trx:Knex.Transaction,s:z.infer<typeof scope>){
  const director=await captureCurrentDirectorForExperiment(trx,s),state=await captureAutoAssetReadContext(trx,s);
  const asset=state.assets.find(a=>a.canonicalKey==='CHAR-003');
  if(!asset||asset.assetKind!=='CREATURE'||asset.sourcePolicy!=='AI_ALLOWED')deny('DIRECTOR_AB_NOT_READY','需要可生成的 CHAR-003 鲸鱼');
  const spec=preparedSpec(state,asset,[]);
  if(!spec)deny('DIRECTOR_AB_NOT_READY','鲸鱼没有可复用的当前视觉草案');
  const compiled=await compileStudioDraftPromptsInTransaction(trx,{...s,items:[{canonicalKey:asset.canonicalKey,sourceAssetRevision:asset.revision,spec}]});
  if(compiled.failures.length)deny('DIRECTOR_AB_NOT_READY',compiled.failures[0].message);
  const route=await resolveEditRouting(trx,s.projectId,'T2I');
  if(route.profile!=='KREA2_T2I_ASSET_V1')deny('DIRECTOR_AB_NOT_READY','当前真实 T2I 路由尚未支持此对照执行器');
  const confirmed=state.specs.find(r=>r.canonicalKey===asset.canonicalKey&&r.sourceAssetRevision===asset.revision);
  const jobs=state.jobs.filter(j=>j.canonicalKey===asset.canonicalKey&&j.sourceAssetRevision===asset.revision).map(j=>({
    id:j.id,status:j.status,draftHash:j.draftHash,executionPurpose:j.executionPurpose,outputsJson:j.outputsJson}));
  const refs=await trx('o_v04AgentReference').where({projectId:s.projectId,targetType:'ASSET_BIBLE',targetKey:asset.canonicalKey}).orderBy('id').limit(201);
  if(refs.length>200)deny('DIRECTOR_AB_NOT_READY','参考来源超过安全上限');
  const evidence={...s,canonicalKey:asset.canonicalKey,assetRevision:asset.revision,
    confirmedVisualSpecRevision:confirmed?.revision??null,visualSpecSource:confirmed?'CONFIRMED':'PERSISTED_DRAFT',
    asset,spec,creative:state.creative,legacyCompilation:compiled.candidates[0],baseline:state.baselines.filter(b=>b.canonicalKey===asset.canonicalKey),references:refs,jobs,
    acceptedDirectorVersion:director.current.directorVersion,acceptedDirectorId:director.current.id,
    directorSourceHash:director.current.sourceHash,directorCandidateHash:director.current.candidateHash,
    directorIntent:director.intent,route,executorConfiguration:state.config,
    baseUrl:localComfyOrigin(state.config?.baseUrl??'http://127.0.0.1:8188'),
    workflowVersion:KREA_EDIT_WORKFLOW_VERSION,legacyCompilerVersion:AUTO_ASSET_RECONCILER_V1,
    renderingLanguageVersion:KREA2_ASSET_T2I_RENDERING_V1,compilerVersion:DIRECTOR_AB_COMPILER};
  if(Buffer.byteLength(JSON.stringify(evidence))>750000)deny('DIRECTOR_AB_NOT_READY','捕获来源超过安全上限');
  return {evidence,sourceHash:abHash(evidence),asset,spec,creative:state.creative,director};
}
const present=(row:any)=>({...JSON.parse(row.compiledJson),status:row.status,execution:JSON.parse(row.executionJson),
  evaluation:row.evaluationJson?JSON.parse(row.evaluationJson):null,updatedAt:row.updatedAt});
async function checked(trx:Knex.Transaction,s:z.infer<typeof command>,actor:number){
  await authorize(trx,s,actor);
  const row=await trx(table).where({id:s.experimentId,projectId:s.projectId,scriptId:s.scriptId}).first();
  if(!row)deny('DIRECTOR_AB_NOT_FOUND','对照实验不存在',404);
  return row;
}
async function fresh(trx:Knex.Transaction,row:any){
  try{return (await captureDirectorABSource(trx,{projectId:row.projectId,scriptId:row.scriptId})).sourceHash===JSON.parse(row.compiledJson).sourceHash;}
  catch(e){if(e instanceof PilotError)return false;throw e;}
}
export async function compileDirectorAB(input:unknown,actor:number){
  const s=scope.parse(input);
  return q.transaction(async trx=>{
    await authorize(trx,s,actor);const c=await captureDirectorABSource(trx,s),id=randomUUID(),createdAt=Date.now();
    const pair=compileDirectorABAssetInput(c.asset,c.spec,c.creative,c.director.intent,c.director.current.directorVersion,c.evidence.legacyCompilation);
    if(!pair.B.directorContext.narrativeRole)deny('DIRECTOR_AB_NOT_READY','当前导演版本缺少鲸鱼叙事角色');
    const seed=parseInt(c.sourceHash.slice(0,12),16),resolution=autoAssetResolution(c.asset.assetKind);
    const build=(prompt:string)=>buildKreaEditWorkflow({profile:c.evidence.route.profile,prompt,seed,...resolution,targetRole:'EXPERIMENTAL_CANDIDATE',jobId:id});
    const workflows={A:build(pair.A.renderedPrompt),B:build(pair.B.renderedPrompt)};
    const result={id,...s,canonicalKey:'CHAR-003',sourceHash:c.sourceHash,evidence:c.evidence,...pair,workflows,
      sharedExecution:{profile:c.evidence.route.profile,workflowVersion:KREA_EDIT_WORKFLOW_VERSION,seed,...resolution,...graphFacts(workflows.A.graph)},createdAt};
    const frozen={...result,pairHash:abHash(result)};
    if(Buffer.byteLength(JSON.stringify(frozen))>2000000)deny('DIRECTOR_AB_NOT_READY','编译结果超过安全上限');
    await trx(table).insert({id,...s,status:'COMPILED',compiledJson:JSON.stringify(frozen),executionJson:'{}',evaluationJson:null,createdAt,updatedAt:createdAt});
    return present({...frozen,compiledJson:JSON.stringify(frozen),executionJson:'{}',status:'COMPILED',updatedAt:createdAt});
  });
}
export async function readDirectorAB(input:unknown,actor:number){
  const s=scope.parse(input);
  return q.transaction(async trx=>{await authorize(trx,s,actor);const rows=await trx(table).where(s).orderBy('createdAt','desc').orderBy('id','desc').limit(20);
    let currentHash:string|null=null;
    try{if(rows.length)currentHash=(await captureDirectorABSource(trx,s)).sourceHash;}catch(e){if(!(e instanceof PilotError))throw e;}
    return rows.map(row=>{const p=present(row);if(p.sourceHash!==currentHash)p.status='STALE';return p;});});
}
// No startup worker and no Auto Asset World job admission. Explicit human render is the only entry.
let rendering=false;
export async function renderDirectorAB(input:unknown,actor:number){
  const s=renderRequest.parse(input);
  const row=await q.transaction(async trx=>{
    await trx(table).where({id:s.experimentId}).update({id:s.experimentId});
    const r=await checked(trx,s,actor),c=JSON.parse(r.compiledJson);
    if(c.pairHash!==s.pairHash)deny('DIRECTOR_AB_INPUT_CHANGED','实验输入不匹配');
    if(r.status!=='COMPILED')return {...r,replayed:true};
    if(!await fresh(trx,r))deny('DIRECTOR_AB_NOT_READY','来源已变化，请重新编译');
    if(rendering||await trx(table).whereIn('status',['RENDERING_A','RENDERING_B']).first()||
       await trx('o_v04StudioAssetDraftJob').whereIn('status',['QUEUED','RUNNING']).first())deny('DIRECTOR_AB_GPU_BUSY','已有图片任务，请等待完成');
    const execution={A:{id:randomUUID(),status:'QUEUED'},B:{id:randomUUID(),status:'QUEUED'}};
    await trx(table).where({id:r.id}).update({status:'RENDERING_A',executionJson:JSON.stringify(execution),updatedAt:Date.now()});
    return {...r,status:'RENDERING_A',executionJson:JSON.stringify(execution)};
  });
  if(!row.replayed){rendering=true;void runPair(row).finally(()=>{rendering=false;}).catch(error=>{
    console.error('[V04 DirectorAB][SettlementFailure]',{experimentId:row.id,errorName:error instanceof Error?error.name:'Error'});
  });}
  return present(row);
}
async function runPair(row:any){
  const c=JSON.parse(row.compiledJson),execution=JSON.parse(row.executionJson),base=c.evidence.baseUrl;
  let side:'A'|'B'='A';
  let release:(()=>Promise<void>)|null=null;
  const save=async(status:string)=>q(table).where({id:row.id}).update({status,executionJson:JSON.stringify(execution),updatedAt:Date.now()});
  try{
    // Share the existing local GPU lease with normal draft production, including other processes.
    release=await acquireDraftWorkerLease(getPath(['v04-draft-worker.lock']));
    if(!release)throw new DraftComfyError('DIRECTOR_AB_GPU_BUSY','已有本地草图执行进程');
    const response=await fetch(base+'/queue',{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new DraftComfyError('COMFY_OFFLINE','无法确认 GPU 队列');
    const queue:any=await response.json();
    if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||queue.queue_running.length||queue.queue_pending.length)
      throw new DraftComfyError('DIRECTOR_AB_GPU_BUSY','Comfy 已有任务');
    for(side of ['A','B'] as const){
      if(!await q.transaction(trx=>fresh(trx,row))) {execution[side].status='NOT_RUN';await save('STALE');return;}
      execution[side].status='RUNNING';await save('RENDERING_'+side);
      const job={id:execution[side].id,projectId:row.projectId,scriptId:row.scriptId,canonicalKey:'CHAR-003',sourceAssetRevision:c.evidence.assetRevision,
        generationIntent:c.evidence.legacyCompilation.generationIntent,executionPurpose:'EXPERIMENTAL_CANDIDATE',executorType:'COMFY_LOCAL',executorProfile:c.sharedExecution.profile,
        inputSnapshotJson:JSON.stringify({sourceType:'DIRECTOR_AB_EXPERIMENT',sourceAssetRevision:c.evidence.assetRevision})};
      const promptId=await submitTracedDraft(base,c.workflows[side],job);execution[side].promptId=promptId;await save('RENDERING_'+side);
      const image=await downloadDraft(base,await awaitDraft(base,promptId,c.workflows[side].outputNode,900000));
      if(image.width!==c.sharedExecution.width||image.height!==c.sharedExecution.height)throw new DraftComfyError('DIRECTOR_AB_NON_COMPARABLE','输出尺寸偏离冻结条件');
      const artifact={artifactId:randomUUID(),role:'EXPERIMENTAL_CANDIDATE',width:image.width,height:image.height,extension:image.extension,mimeType:image.mimeType,
        sha256:createHash('sha256').update(image.bytes).digest('hex')};
      const directory=getPath(['v04-director-ab',String(row.projectId),row.id]);await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(getPath(['v04-director-ab',String(row.projectId),row.id,artifact.artifactId+'.'+artifact.extension]),image.bytes,{flag:'wx'});
      execution[side]={...execution[side],status:'SUCCEEDED',artifact};
      await q('o_v04ExecutionTrace').where({jobId:job.id,status:'RUNNING'}).update({status:'SUCCEEDED',outputArtifactIdsJson:JSON.stringify([artifact.artifactId]),completedAt:Date.now(),updatedAt:Date.now()});
      await save('RENDERING_'+side);
    }
    execution.completedAt=Date.now();await save(await q.transaction(trx=>fresh(trx,row))?'COMPLETED':'STALE');
  }catch(error){
    const code=error instanceof DraftComfyError?error.code:'EXECUTION_UNCERTAIN';
    execution[side]={...execution[side],status:'FAILED',errorCode:code};execution.errorCode=code;
    if(side==='A')execution.B.status='NOT_RUN';
    await q('o_v04ExecutionTrace').where({jobId:execution[side].id}).whereIn('status',['QUEUED','RUNNING']).update({status:'FAILED',errorCode:code,errorDetail:code,completedAt:Date.now(),updatedAt:Date.now()});
    await save('FAILED');
  }finally{if(release)await release();}
}
export async function evaluateDirectorAB(input:unknown,actor:number){
  const s=evaluationRequest.parse(input);
  return q.transaction(async trx=>{await trx(table).where({id:s.experimentId}).update({id:s.experimentId});const r=await checked(trx,s,actor);
    if(r.status!=='COMPLETED'||!await fresh(trx,r))deny('DIRECTOR_AB_NOT_READY','只能评价来源当前且完整的对照');
    const evaluation={choices:s.choices,conclusion:s.conclusion,why:s.why,actorUserId:actor,createdAt:Date.now()};
    await trx(table).where({id:r.id}).update({evaluationJson:JSON.stringify(evaluation),updatedAt:Date.now()});return evaluation;});
}
export async function directorABArtifact(input:unknown,actor:number){
  const s=command.extend({side:z.enum(['A','B'])}).strict().parse(input);
  const a=await q.transaction(async trx=>{const row=await checked(trx,s,actor);return JSON.parse(row.executionJson)[s.side]?.artifact;});
  if(!a)deny('DIRECTOR_AB_ARTIFACT_MISSING','实验图片不存在',404);
  const bytes=await fs.readFile(getPath(['v04-director-ab',String(s.projectId),s.experimentId,a.artifactId+'.'+a.extension]));
  if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)deny('DIRECTOR_AB_ARTIFACT_MISSING','实验图片校验失败',404);
  return {bytes,mimeType:a.mimeType};
}

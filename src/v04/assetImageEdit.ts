import {buildKleinAssetWorkflow,KLEIN_ASSET_VIEW_V1,KLEIN_ASSET_WORKFLOW_VERSION,kleinModels} from './kleinAssetProfile';
import {ASSET_PIPELINE_VERSION,compilePipelineAssetPrompt} from './assetPipelinePrompt';
import {autoJobFresh,captureAutoAssetReadContext,reconcileAutoAssetsInTransaction,preparedSpec} from './autoAsset';
import {captureDirectorReferenceBoundary,inheritDirectorMainReference} from './directorBible';
import {compileVisualSemantic} from './visualSpecContract';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Knex} from 'knex';
import {z} from 'zod';
import {db} from '@/utils/db';
import getPath from '@/utils/getPath';
import {PilotError} from './service';
import {getDraftArtifact,wakeDraftWorker} from './studioDraftImage';
import {getAgentAttachmentBytes} from './agentAttachments';
import {imageEditIntent,sourceRolePriority,editExecutionPrompt,type ImageEditIntent} from './assetImageEditContract';
import {buildKreaEditWorkflow,kreaModels,KREA_EDIT_WORKFLOW_VERSION,uploadEditInput} from './kreaImageEditProfile';
import {localComfyOrigin,awaitDraft,downloadDraft,DraftComfyError} from './comfyDraftClient';
import {baselinesInTransaction,suitableBaseline,recordCandidateBaseline} from './assetImageBaseline';
import {resolveEditRouting} from './operations';
import {submitTracedDraft,failSubmittedTrace} from './tracedDraftSubmit';
import {settleJobTraces} from './executionTrace';
import {inspectAssetCandidate} from './assetPipelineQuality';
import {createLocalFastVisionAdapter} from './localFastVision';
const q=db as Knex;
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
const scopeSchema=z.object({projectId:z.number().int().positive(),scriptId:z.number().int().positive()}).strict();
const jobRequest=scopeSchema.extend({jobId:z.string().uuid()});
async function assertScope(trx:Knex.Transaction,scope:{projectId:number;scriptId:number}){
 if(!await trx('o_script').where({id:scope.scriptId,projectId:scope.projectId}).first())throw new PilotError('PILOT_SCOPE_INVALID','制作单元不存在',404);
}
async function capture(trx:Knex.Transaction,scope:{projectId:number;scriptId:number},intent:ImageEditIntent,parentCandidateId?:string,mainPipeline=false){
 await assertScope(trx,scope);
 const asset=await trx('o_v04Asset').where({projectId:scope.projectId,canonicalKey:intent.canonicalKey,status:'ACTIVE'}).first();
 if(!asset)throw new PilotError('PILOT_TARGET_INVALID','请先选择有效素材',404);
 if(asset.sourcePolicy!=='AI_ALLOWED'||['BRAND','UI'].includes(asset.category)||['BRAND_MARK','UI_REFERENCE'].includes(asset.assetKind))throw new PilotError('PILOT_REAL_REFERENCE_ONLY','真实品牌和界面不能通过 AI 重绘',409);
 const jobs=await trx('o_v04StudioAssetDraftJob').where({...scope,canonicalKey:asset.canonicalKey,sourceAssetRevision:asset.revision,status:'SUCCEEDED'}).whereRaw("COALESCE(json_extract(inputSnapshotJson, '$.packageStage'), '') != 'DRAFT_KREA'").orderBy('createdAt','desc').limit(100);
 const rejected=await trx('o_v04Decision').where({projectId:scope.projectId,scriptId:scope.scriptId,category:'ASSET_IMAGE_EDIT',status:'REJECTED'}).limit(300);
 const rejectIds=new Set(rejected.map((r:any)=>r.subjectKey));
 const eligible=jobs.filter((j:any)=>!rejectIds.has(j.id));
 const baseline=suitableBaseline((await baselinesInTransaction(trx,scope)).filter((b:any)=>b.sourceAssetRevision===asset.revision),asset.canonicalKey,mainPipeline?'BODY':intent.targetRole==='FACE_HERO'?'FACE':intent.targetRole==='FULL_BODY_BACK'?'BACK':intent.sourceFocus);
 let source:any=null,sourceRole:string|undefined,artifact:any=null,sourceAttachment:any=null;
 if(intent.sourceAttachmentId){sourceAttachment=await trx('o_v04AgentAttachment').where({id:intent.sourceAttachmentId,...scope}).first();if(!sourceAttachment?.messageId)throw new PilotError('PILOT_REFERENCE_INVALID','本次来源图片不属于当前对话',409);}
 else if(parentCandidateId&&!intent.useBaseline){source=eligible.find((j:any)=>j.id===parentCandidateId);if(!source)throw new PilotError('PILOT_SOURCE_STALE','上一个候选已失效',409);}
 else if(baseline){sourceAttachment=await trx('o_v04AgentAttachment').where({id:baseline.attachmentId,...scope}).first();if(!sourceAttachment||sourceAttachment.sha256!==baseline.sha256)throw new PilotError('PILOT_SOURCE_STALE','当前基准图片不可用',409);}
 else for(const role of mainPipeline&&intent.editMode==='DERIVE_VIEW'?['MAIN_PREVIEW']:sourceRolePriority(intent)){source=eligible.find((j:any)=>JSON.parse(j.outputsJson).some((o:any)=>o.role===role));if(source){sourceRole=role;break;}}
 if(!sourceAttachment&&!source)throw new PilotError('PILOT_SOURCE_MISSING','当前素材尚无可修改的图片，请先上传并确认基准',409);
 if(source){const outputs=JSON.parse(source.outputsJson),output=sourceRole?outputs.find((o:any)=>o.role===sourceRole):outputs[0];artifact=await trx('o_v04StudioDraftArtifact').where({artifactId:output?.artifactId,jobId:source.id,projectId:scope.projectId}).first();if(!artifact)throw new PilotError('ARTIFACT_MISSING','源图片暂不可用',409);}
 const refs=[];for(const binding of intent.referenceBindings){
  const row=await trx('o_v04AgentAttachment').where({id:binding.attachmentId,projectId:scope.projectId}).first();
  if(!row||row.scriptId!==scope.scriptId||!row.messageId)throw new PilotError('PILOT_REFERENCE_INVALID','参考图片不属于这次对话或制作单元',409);
  const promotion=row.purpose==='GENERATED_CANDIDATE'?await trx('o_v04Decision').where({...scope,category:'ASSET_IMAGE_EDIT',status:'ACCEPTED'}).whereRaw("json_extract(content, '$.attachmentId') = ?",[row.id]).first():null;
  refs.push({attachmentId:row.id,role:binding.role,sha256:row.sha256,purpose:row.purpose,sourceArtifactId:promotion?JSON.parse(promotion.content).artifactId:null});
 }
 // Bound the MVP to one external style reference; never silently drop extra inputs.
 if(refs.length>1)throw new PilotError('CAPABILITY_LIMITED','这次请先使用一张参考图；多图修改暂未验证',409);
 const spec=await trx('o_v04AssetVisualSpec').where({projectId:scope.projectId,canonicalKey:asset.canonicalKey,status:'CONFIRMED'}).orderBy('revision','desc').first();
 const config=await trx('o_v04StudioImageExecutorConfig').where({projectId:scope.projectId}).first();
 const baseUrl=localComfyOrigin(config?.baseUrl??'http://127.0.0.1:8188');
 const routing=await resolveEditRouting(trx,scope.projectId,intent.editMode==='DERIVE_VIEW'?'DERIVE_VIEW':intent.referenceBindings.length?'REFERENCE_EDIT':'SOURCE_EDIT',mainPipeline);
 return {asset:{canonicalKey:asset.canonicalKey,revision:asset.revision,category:asset.category,sourcePolicy:asset.sourcePolicy},
  sourceType:sourceAttachment?'ATTACHMENT':'ARTIFACT',sourceAttachmentId:sourceAttachment?.id??null,sourceAttachmentHash:sourceAttachment?.sha256??null,baselineVersion:baseline?.version??null,baselineRole:baseline?.role??null,
  sourceArtifactId:artifact?.artifactId??null,sourceJobId:source?.id??null,parentCandidateId:source?.generationIntent==='ASSET_IMAGE_EDIT'?source.id:null,
  sourceSpecHash:spec?sha(spec):null,referenceBindings:refs,referenceArtifactIds:refs.map(r=>r.sourceArtifactId).filter(Boolean),uploadedReferenceIds:refs.filter(r=>r.purpose==='CONVERSATIONAL_REFERENCE').map(r=>r.attachmentId),baseUrl,intent,routing};
}
export async function enqueueAssetImageEdit(scope:{projectId:number;scriptId:number},raw:unknown,userMessageId:string,parentCandidateId?:string,mainPipeline=false){
 const parsed=imageEditIntent.parse(raw);
 const intent=mainPipeline?{...parsed,...(parsed.editMode!=='DERIVE_VIEW'?{targetRole:'EDIT_CANDIDATE' as const}:{}),sourceFocus:'BODY' as const}:parsed;
 if(mainPipeline&&intent.editMode==='DERIVE_VIEW'&&(intent.sourceAttachmentId||parentCandidateId))throw new PilotError('PILOT_MAIN_REQUIRED','派生视角必须使用当前主图',409);
 const snapshot=await q.transaction(trx=>capture(trx,scope,intent,parentCandidateId,mainPipeline));

 if(mainPipeline){
  const requestId=userMessageId;
  const result=await q.transaction(async trx=>{const context=await captureAutoAssetReadContext(trx,scope),asset=context.assets.find(a=>a.canonicalKey===intent.canonicalKey)!;const spec=preparedSpec(context,asset,[])??compileVisualSemantic({...asset,identityAnchors:JSON.parse(asset.identityAnchors),mustPreserve:JSON.parse(asset.mustPreserve),forbiddenChanges:JSON.parse(asset.forbiddenChanges)},{});return reconcileAutoAssetsInTransaction(trx,{...scope,items:[{canonicalKey:asset.canonicalKey,sourceAssetRevision:asset.revision,spec}],canonicalKeys:[intent.canonicalKey],...(intent.editMode==='DERIVE_VIEW'?{}:{regenerateKey:intent.canonicalKey,requestId}),userMessageId,...(intent.editMode==='DERIVE_VIEW'?{}:{assetIntentPatch:intent.editPrompt})},intent.editMode==='DERIVE_VIEW'?null:snapshot);});
  const admitted=result.results.find((r:any)=>r.jobId);if(!admitted)throw new PilotError('PILOT_PACKAGE_NOT_ADMITTED','资产包未能进入准备，请检查导演与视觉规格',409);
  wakeDraftWorker();return {jobId:admitted.jobId,status:admitted.status,canonicalKey:intent.canonicalKey,applied:false,packagePending:true};
 }
 const profile=snapshot.routing.profile;
 const source=snapshot.sourceAttachmentId?await getAgentAttachmentBytes(scope.projectId,snapshot.sourceAttachmentId):await getDraftArtifact(scope.projectId,snapshot.sourceArtifactId!);
 const referenceHashes=await Promise.all(snapshot.referenceBindings.map(async r=>{const file=await getAgentAttachmentBytes(scope.projectId,r.attachmentId);if(bytesHash(file.bytes)!==r.sha256)throw new PilotError('PILOT_REFERENCE_INVALID','参考图片内容已变化',409);return r.sha256;}));
 const sourceSha256=bytesHash(source.bytes);
 if(mainPipeline&&intent.editMode==='DERIVE_VIEW'&&intent.referenceBindings.length)throw new PilotError('CAPABILITY_LIMITED','多视角只使用当前主图，请先修改主图',409);
 if(mainPipeline&&intent.editMode==='DERIVE_VIEW'&&profile!==KLEIN_ASSET_VIEW_V1)throw new PilotError('PILOT_ROUTE_INCOMPATIBLE','请在专业配置启用多视角执行器',409);
 if(mainPipeline&&intent.editMode!=='DERIVE_VIEW'&&!['KREA2_SOURCE_EDIT_V1','KREA2_REFERENCE_EDIT_V1'].includes(profile))throw new PilotError('PILOT_ROUTE_INCOMPATIBLE','主图修改执行器不兼容',409);
 const context=mainPipeline?await q.transaction(trx=>captureAutoAssetReadContext(trx,scope)):null;
 if(context?.directorBlocked)throw new PilotError('DIRECTOR_SOURCE_STALE','请先审阅当前导演方向',409);
 const asset=context?.assets.find(a=>a.canonicalKey===intent.canonicalKey),spec=asset?context?.specs.find(s=>s.canonicalKey===asset.canonicalKey&&s.sourceAssetRevision===asset.revision):null;
 const visual=asset&&context?(preparedSpec(context,asset,[])??compileVisualSemantic({...asset,identityAnchors:JSON.parse(asset.identityAnchors),mustPreserve:JSON.parse(asset.mustPreserve),forbiddenChanges:JSON.parse(asset.forbiddenChanges)},{})):spec?JSON.parse(spec.specJson):null;
 const executionPrompt=mainPipeline?compilePipelineAssetPrompt(asset,visual,intent.editMode==='DERIVE_VIEW'?intent.targetRole:'ASSET_MAIN_PREVIEW',context?.director).renderedPrompt+'\nRequested edit: '+editExecutionPrompt(intent):editExecutionPrompt(intent);
 if(snapshot.sourceAttachmentId&&sourceSha256!==snapshot.sourceAttachmentHash)throw new PilotError('PILOT_SOURCE_STALE','上传来源内容已变化',409);
 const workflowVersion=profile===KLEIN_ASSET_VIEW_V1?KLEIN_ASSET_WORKFLOW_VERSION:KREA_EDIT_WORKFLOW_VERSION;
 const frozen={...snapshot,...(mainPipeline?{pipelineVersion:ASSET_PIPELINE_VERSION,pipelineMain:intent.editMode!=='DERIVE_VIEW',visualSpecDraft:visual,directorSemanticHash:context?.director?sha(context.director.intent):null}:{}),sourceSha256,referenceHashes,executorProfile:profile,workflowVersion,models:profile===KLEIN_ASSET_VIEW_V1?kleinModels:kreaModels,executionPrompt,width:768,height:profile===KLEIN_ASSET_VIEW_V1?1024:768,fallbackPolicy:{knownOutOfMemoryResolution:512,maxAttempts:2},userMessageId};
 const draftHash=sha(frozen),seed=parseInt(draftHash.slice(0,12),16),now=Date.now();
 const result=await q.transaction(async trx=>{
  const existing=await trx('o_v04StudioAssetDraftJob').where({id:userMessageId,...scope}).first();if(existing)return existing;
  const check=await capture(trx,scope,intent,parentCandidateId,mainPipeline);if(sha(check)!==sha(snapshot))throw new PilotError('PILOT_SOURCE_STALE','素材来源刚刚变化，请重试',409);
  const row={id:userMessageId,...scope,canonicalKey:intent.canonicalKey,sourceAssetRevision:snapshot.asset.revision,draftHash,generationIntent:'ASSET_IMAGE_EDIT',executionPurpose:intent.targetRole,
   executorType:'COMFY_LOCAL',executorProfile:profile,workflowVersion,status:'QUEUED',comfyPromptId:null,
   inputSnapshotJson:JSON.stringify({...frozen,seed}),outputsJson:'[]',errorCode:null,errorMessage:null,attemptCount:1,createdAt:now,startedAt:null,completedAt:null,updatedAt:now};
  await trx('o_v04StudioAssetDraftJob').insert(row);return row;
 });wakeDraftWorker();return {jobId:result.id,status:result.status,canonicalKey:result.canonicalKey,applied:false};
}
function sourceIsCurrent(job:any,snapshot:any,asset:any,spec:any,source:any,refs:any[],rejected:boolean,baseline:any=null){
 return !!asset && asset.status==='ACTIVE' && asset.revision===job.sourceAssetRevision && asset.sourcePolicy==='AI_ALLOWED'
  && !['BRAND','UI'].includes(asset.category) && !!source
  && (snapshot.sourceAttachmentId ? source.id===snapshot.sourceAttachmentId&&source.sha256===snapshot.sourceAttachmentHash : source.status==='SUCCEEDED'&&source.canonicalKey===job.canonicalKey&&source.sourceAssetRevision===job.sourceAssetRevision)
  && (!('baselineVersion' in snapshot)||(baseline?.version??null)===snapshot.baselineVersion||baseline?.sourceJobId===job.id)
  && (spec?sha(spec):null)===snapshot.sourceSpecHash && !rejected
  && snapshot.referenceBindings.every((r:any)=>refs.some(a=>a.id===r.attachmentId&&a.sha256===r.sha256));
}
async function fresh(job:any,snapshot:any,trx:Knex.Transaction){
 if(snapshot.pipelineVersion){const context=await captureAutoAssetReadContext(trx,{projectId:job.projectId,scriptId:job.scriptId});if(context.directorBlocked||snapshot.directorSemanticHash!==(context.director?sha(context.director.intent):null))return false;}
 const asset=await trx('o_v04Asset').where({projectId:job.projectId,canonicalKey:job.canonicalKey,status:'ACTIVE'}).first();
 const source=snapshot.sourceAttachmentId?await trx('o_v04AgentAttachment').where({id:snapshot.sourceAttachmentId,projectId:job.projectId,scriptId:job.scriptId}).first():await trx('o_v04StudioAssetDraftJob').where({id:snapshot.sourceJobId,projectId:job.projectId,scriptId:job.scriptId,status:'SUCCEEDED'}).first();
 const baseline=suitableBaseline(await baselinesInTransaction(trx,{projectId:job.projectId,scriptId:job.scriptId}),job.canonicalKey,snapshot.pipelineVersion?'BODY':snapshot.intent.targetRole==='FACE_HERO'?'FACE':snapshot.intent.targetRole==='FULL_BODY_BACK'?'BACK':snapshot.intent.sourceFocus);
 const spec=await trx('o_v04AssetVisualSpec').where({projectId:job.projectId,canonicalKey:job.canonicalKey,status:'CONFIRMED'}).orderBy('revision','desc').first();
 const rejected=await trx('o_v04Decision').where({projectId:job.projectId,scriptId:job.scriptId,category:'ASSET_IMAGE_EDIT',subjectKey:snapshot.sourceJobId??'',status:'REJECTED'}).first();
 const refs=await trx('o_v04AgentAttachment').where({projectId:job.projectId,scriptId:job.scriptId}).whereIn('id',snapshot.referenceBindings.map((r:any)=>r.attachmentId));
 return sourceIsCurrent(job,snapshot,asset,spec,source,refs,!!rejected,baseline);
}
export async function produceAssetImageEdit(job:any,freshClaim:boolean){
 const snapshot=JSON.parse(job.inputSnapshotJson);
 try{
  if(!job.comfyPromptId&&!await q.transaction(trx=>fresh(job,snapshot,trx))){await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:'STALE',errorCode:'STALE_JOB',updatedAt:Date.now()});return;}
  if(!freshClaim&&!job.comfyPromptId)throw new DraftComfyError('EXECUTION_UNCERTAIN','上次修改结果不确定，现有素材未替换');
  const base=localComfyOrigin(snapshot.baseUrl);let workflow;
  if(!job.comfyPromptId){
   const src=snapshot.sourceAttachmentId?await getAgentAttachmentBytes(job.projectId,snapshot.sourceAttachmentId):await getDraftArtifact(job.projectId,snapshot.sourceArtifactId);if(bytesHash(src.bytes)!==snapshot.sourceSha256)throw new DraftComfyError('SOURCE_CHANGED','源图片内容已变化');
   const sourceImage=await uploadEditInput(base,src.bytes,`ds-edit-${job.id}-source.png`);let referenceImage:string|undefined;
   if(snapshot.referenceBindings.length){const ref=await getAgentAttachmentBytes(job.projectId,snapshot.referenceBindings[0].attachmentId);if(bytesHash(ref.bytes)!==snapshot.referenceBindings[0].sha256)throw new DraftComfyError('SOURCE_CHANGED','参考图片内容已变化');referenceImage=await uploadEditInput(base,ref.bytes,`ds-edit-${job.id}-reference.png`);}
   workflow=job.executorProfile===KLEIN_ASSET_VIEW_V1?buildKleinAssetWorkflow({prompt:snapshot.executionPrompt,seed:snapshot.seed,sourceImage,targetRole:job.executionPurpose,jobId:job.id}):buildKreaEditWorkflow({profile:job.executorProfile,prompt:snapshot.executionPrompt,seed:snapshot.seed,width:snapshot.recovery?.width??snapshot.width,height:snapshot.recovery?.height??snapshot.height,sourceImage,referenceImage,targetRole:job.executionPurpose,jobId:job.id});
   const promptId=await submitTracedDraft(base,workflow,job);await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({comfyPromptId:promptId,updatedAt:Date.now()});job.comfyPromptId=promptId;
  }
  const image=await awaitDraft(base,job.comfyPromptId,'22',900000),output=await downloadDraft(base,image);
  const artifactId=randomUUID(),createdAt=Date.now(),file=getPath(['v04-draft-artifacts',String(job.projectId),`${artifactId}.${output.extension}`]);
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,output.bytes,{flag:'wx'});
  let quality=null;
  if(snapshot.pipelineVersion){
   const source=snapshot.sourceAttachmentId?await getAgentAttachmentBytes(job.projectId,snapshot.sourceAttachmentId):await getDraftArtifact(job.projectId,snapshot.sourceArtifactId);
   const view=snapshot.pipelineMain?'MAIN':/SIDE/.test(job.executionPurpose)?'SIDE':/BACK|REAR/.test(job.executionPurpose)?'BACK':'FRONT';
   quality=await inspectAssetCandidate(output,{view,profile:snapshot.visualSpecDraft.assetKind,mustPreserve:snapshot.visualSpecDraft.mustPreserve,confirmedPhysicalFacts:snapshot.visualSpecDraft.details},createLocalFastVisionAdapter([{view:'MAIN',bytes:source.bytes,mimeType:'image/png'},{view,bytes:output.bytes,mimeType:output.mimeType}],true));
  }
  const artifact={artifactId,role:job.executionPurpose,mimeType:output.mimeType,width:output.width,height:output.height,sha256:bytesHash(output.bytes),quality,fileRef:`/api/v04/studio/artifact/${job.projectId}/${artifactId}`,createdAt};
  await q.transaction(async trx=>{
   const current=await trx('o_v04StudioAssetDraftJob').where({id:job.id}).first();
   await trx('o_v04StudioDraftArtifact').insert({artifactId,jobId:job.id,projectId:job.projectId,mimeType:output.mimeType,extension:output.extension,role:job.executionPurpose,width:output.width,height:output.height,createdAt});
   if(current?.status==='RUNNING'){
    const currentSource=await fresh(job,snapshot,trx),failed=quality?.status==='CLEAR_FAILURE';
    await trx('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:!currentSource?'STALE':failed?'FAILED':'SUCCEEDED',errorCode:failed?'QUALITY_CLEAR_FAILURE':null,outputsJson:JSON.stringify([artifact]),completedAt:createdAt,updatedAt:createdAt});
    if(currentSource&&failed&&job.attemptCount===1){
     const retry={...snapshot,retryOf:job.id,retryRootHash:job.draftHash,seed:snapshot.seed+1};
     await trx('o_v04StudioAssetDraftJob').insert({...job,id:randomUUID(),status:'QUEUED',comfyPromptId:null,draftHash:sha(retry),inputSnapshotJson:JSON.stringify(retry),outputsJson:'[]',attemptCount:2,errorCode:null,errorMessage:null,createdAt,updatedAt:createdAt,startedAt:null,completedAt:null});
    }
   }
   else if(current?.status==='STALE')await trx('o_v04StudioAssetDraftJob').where({id:job.id,status:'STALE'}).update({outputsJson:JSON.stringify([artifact]),completedAt:createdAt,updatedAt:createdAt});
  });
 }catch(error){
  const code=error instanceof DraftComfyError?error.code:'EXECUTION_FAILED';console.error('[V04 AssetEdit]',{jobId:job.id,code,errorName:error instanceof Error?error.name:'Error'});
  await failSubmittedTrace(job,code);
  // Only a confirmed terminal OOM may submit once more. Lost submission or
  // transport responses never authorize an automatic duplicate execution.
  if(job.executorProfile!==KLEIN_ASSET_VIEW_V1&&code==='OUT_OF_MEMORY'&&job.attemptCount===1&&!snapshot.recovery&&snapshot.fallbackPolicy?.maxAttempts===2){
   const retrySnapshot={...snapshot,recovery:{failedPromptId:job.comfyPromptId,reason:code,width:512,height:512,attempt:2}};
   const changed=await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({inputSnapshotJson:JSON.stringify(retrySnapshot),comfyPromptId:null,attemptCount:2,updatedAt:Date.now()});
   if(changed)return produceAssetImageEdit({...job,inputSnapshotJson:JSON.stringify(retrySnapshot),comfyPromptId:null},true);
   return;
  }
  await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:'FAILED',errorCode:code,errorMessage:code==='EXECUTION_UNCERTAIN'?'上次请求结果未确认，现有素材没有被替换。请先核对结果，再决定是否重试。':'这次生成没有成功，我没有替换现有资产。可以重新尝试。',completedAt:Date.now(),updatedAt:Date.now()});
 }finally{await settleJobTraces(job.id);}
}
export async function listAssetImageCandidates(input:unknown){const scope=scopeSchema.parse(input);return q.transaction(async trx=>{
 await assertScope(trx,scope);const rows=await trx('o_v04StudioAssetDraftJob').where(scope).where(function(){this.where({generationIntent:'ASSET_IMAGE_EDIT'}).orWhereRaw("json_extract(inputSnapshotJson, '$.autoVersion') IS NOT NULL");}).whereRaw("COALESCE(json_extract(inputSnapshotJson, '$.packageStage'), '') != 'DRAFT_KREA'" ).orderBy('createdAt','desc').limit(100);
 const decisions=await trx('o_v04Decision').where({...scope,category:'ASSET_IMAGE_EDIT'}).orderBy('createdAt','desc').limit(300);
 const snapshots=rows.map((j:any)=>JSON.parse(j.inputSnapshotJson)),keys=[...new Set(rows.map((j:any)=>j.canonicalKey))];
 const assets=await trx('o_v04Asset').where({projectId:scope.projectId}).whereIn('canonicalKey',keys);
 const latest=trx('o_v04AssetVisualSpec').select('canonicalKey').max('revision as revision').where({projectId:scope.projectId,status:'CONFIRMED'}).whereIn('canonicalKey',keys).groupBy('canonicalKey').as('latest');
 const specs=await trx('o_v04AssetVisualSpec as s').join(latest,function(){this.on('s.canonicalKey','=','latest.canonicalKey').andOn('s.revision','=','latest.revision');}).where({'s.projectId':scope.projectId,'s.status':'CONFIRMED'}).select('s.*');
 const sources=await trx('o_v04StudioAssetDraftJob').where(scope).whereIn('id',snapshots.map((s:any)=>s.sourceJobId).filter(Boolean));
 const attachmentSources=await trx('o_v04AgentAttachment').where(scope).whereIn('id',snapshots.map((s:any)=>s.sourceAttachmentId).filter(Boolean));
 const baselines=await baselinesInTransaction(trx,scope);
 const refs=await trx('o_v04AgentAttachment').where(scope).whereIn('id',snapshots.flatMap((s:any)=>(s.referenceBindings??[]).map((r:any)=>r.attachmentId)));
 const autoContext=rows.some((j:any)=>JSON.parse(j.inputSnapshotJson).autoVersion)?await captureAutoAssetReadContext(trx,scope):undefined;
 return Promise.all(rows.map(async(j:any,i:number)=>{const s=snapshots[i],asset=assets.find((a:any)=>a.canonicalKey===j.canonicalKey),spec=specs.find((a:any)=>a.canonicalKey===j.canonicalKey);
  const current=s.autoVersion?await autoJobFresh(j,trx,autoContext):sourceIsCurrent(j,s,asset,spec,s.sourceAttachmentId?attachmentSources.find((p:any)=>p.id===s.sourceAttachmentId):sources.find((p:any)=>p.id===s.sourceJobId),refs,decisions.some((d:any)=>d.subjectKey===s.sourceJobId&&d.status==='REJECTED'),suitableBaseline(baselines,j.canonicalKey,s.pipelineVersion?'BODY':s.intent.targetRole==='FACE_HERO'?'FACE':s.intent.targetRole==='FULL_BODY_BACK'?'BACK':s.intent.sourceFocus));
  return {packageId:s.packageId??null,packageStage:s.packageStage??null,id:j.id,assetName:asset?.name??'素材',canonicalKey:j.canonicalKey,sourceAssetRevision:j.sourceAssetRevision,userMessageId:s.userMessageId,parentCandidateId:s.parentCandidateId,sourceArtifactId:s.sourceArtifactId,targetRole:j.executionPurpose,automatic:!!s.autoVersion,generationIntent:j.generationIntent,startedAt:j.startedAt??null,completedAt:j.completedAt??null,updatedAt:j.updatedAt,status:j.status==='SUCCEEDED'&&!current?'STALE':j.status,outputs:JSON.parse(j.outputsJson),errorMessage:j.errorMessage,decision:decisions.find((d:any)=>d.subjectKey===j.id)?.status??null,createdAt:j.createdAt};}));
});}
async function candidatePlan(trx:Knex.Transaction,data:z.infer<typeof jobRequest>){
 await assertScope(trx,data);const job=await trx('o_v04StudioAssetDraftJob').where({id:data.jobId,projectId:data.projectId,scriptId:data.scriptId,status:'SUCCEEDED'}).first();
 if(!job||JSON.parse(job.inputSnapshotJson).packageStage==='DRAFT_KREA'||!(JSON.parse(job.inputSnapshotJson).autoVersion?await autoJobFresh(job,trx):job.generationIntent==='ASSET_IMAGE_EDIT'&&await fresh(job,JSON.parse(job.inputSnapshotJson),trx)))throw new PilotError('PILOT_SOURCE_STALE','候选已过期，不能采用',409);
 const decisions=await trx('o_v04Decision').where({projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectKey:job.id}).orderBy('createdAt','desc');
 if(decisions[0]?.status==='REJECTED')throw new PilotError('PILOT_CANDIDATE_REJECTED','此候选已放弃',409);
 return {job,previewHash:sha({id:job.id,draftHash:job.draftHash,outputs:job.outputsJson,decision:decisions[0]?.id??null})};
}
export async function previewAssetImageCandidate(input:unknown){const d=jobRequest.parse(input);return q.transaction(async trx=>{const plan=await candidatePlan(trx,d);return {previewHash:plan.previewHash,canonicalKey:plan.job.canonicalKey,notice:'确认后将这张候选登记为已确认素材参考；不会替换 Visual Spec、正式生产绑定或当前生产产物。'};});}
export async function acceptAssetImageCandidate(input:unknown){
 const data=jobRequest.extend({previewHash:z.string().length(64)}).strict().parse(input);
 const replay=await q('o_v04Decision').where({projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectKey:data.jobId,status:'ACCEPTED'}).first();
 if(replay){const stored=JSON.parse(replay.content);if(stored.previewHash!==data.previewHash)throw new PilotError('PILOT_PREVIEW_STALE','这张候选已采用，请刷新',409);return {applied:true,replayed:true,artifactId:stored.artifactId,attachmentId:stored.attachmentId};}
 const plan=await q.transaction(trx=>candidatePlan(trx,data));if(plan.previewHash!==data.previewHash)throw new PilotError('PILOT_PREVIEW_STALE','候选预览已过期',409);
 const candidateOutput=JSON.parse(plan.job.outputsJson)[0],artifactId=candidateOutput.artifactId,media=await getDraftArtifact(data.projectId,artifactId),id=randomUUID();
 if(candidateOutput.sha256 && bytesHash(media.bytes)!==candidateOutput.sha256)throw new PilotError('PILOT_SOURCE_STALE','候选图片内容已变化',409);
 const ext=media.mimeType==='image/jpeg'?'jpg':media.mimeType==='image/webp'?'webp':'png';const file=getPath(['v04-conversation',String(data.projectId),`${id}.${ext}`]);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,media.bytes,{flag:'wx'});
 try{return await q.transaction(async trx=>{
  await trx('o_script').where({id:data.scriptId,projectId:data.projectId}).update({id:data.scriptId});
  const current=await candidatePlan(trx,data);if(current.previewHash!==data.previewHash)throw new PilotError('PILOT_PREVIEW_STALE','候选预览已过期',409);
  const existing=await trx('o_v04Decision').where({projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectKey:plan.job.id,status:'ACCEPTED'}).first();if(existing)return {applied:true,replayed:true};
  const now=Date.now(),snapshot=JSON.parse(plan.job.inputSnapshotJson);
  const mainAdoption=!!snapshot.pipelineMain||plan.job.executionPurpose==='ASSET_MAIN_PREVIEW';
  const directorBoundary=(mainAdoption||snapshot.pipelineVersion)?await captureDirectorReferenceBoundary(trx,{projectId:data.projectId,scriptId:data.scriptId}):null;
  await trx('o_v04AgentAttachment').insert({id,projectId:data.projectId,scriptId:data.scriptId,messageId:snapshot.userMessageId??null,contextJson:JSON.stringify({projectId:data.projectId,scriptId:data.scriptId,currentStage:'studio',currentRoute:'studio',selectedObject:{type:'ASSET',key:plan.job.canonicalKey}}),filePath:`/v04-conversation/${data.projectId}/${id}.${ext}`,originalName:`${plan.job.canonicalKey}-candidate.png`,mimeType:media.mimeType,bytes:media.bytes.length,sha256:bytesHash(media.bytes),purpose:'GENERATED_CANDIDATE',createdAt:now});
  await recordCandidateBaseline(trx,plan.job,id,{...candidateOutput,sha256:bytesHash(media.bytes)},data.previewHash);
  await trx('o_v04AgentReference').insert({id:randomUUID(),projectId:data.projectId,scriptId:data.scriptId,attachmentId:id,targetType:'ASSET_BIBLE',targetKey:plan.job.canonicalKey,assetId:null,createdAt:now});
  await trx('o_v04Decision').insert({id:randomUUID(),projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectType:'ASSET',subjectKey:plan.job.id,content:JSON.stringify({canonicalKey:plan.job.canonicalKey,artifactId,attachmentId:id,previewHash:data.previewHash}),status:'ACCEPTED',sourceMessageIds:JSON.stringify([snapshot.userMessageId].filter(Boolean)),supersedesDecisionId:null,createdAt:now,acceptedAt:now});
  const continuity=directorBoundary?await inheritDirectorMainReference(trx,{projectId:data.projectId,scriptId:data.scriptId},directorBoundary,plan.job.canonicalKey,id,mainAdoption?'MAIN_REFERENCE_REPLACEMENT':'DERIVED_REFERENCE_ADOPTION'):null;
  const derivation=mainAdoption?await reconcileAutoAssetsInTransaction(trx,{projectId:data.projectId,scriptId:data.scriptId,canonicalKeys:[plan.job.canonicalKey],viewsOnly:true}):null;
  return {applied:true,artifactId,attachmentId:id,derivation,continuity};
 });}catch(e){await fs.unlink(file).catch(()=>{});throw e;}
}
export async function rejectAssetImageCandidate(input:unknown){const data=jobRequest.parse(input);return q.transaction(async trx=>{
 await assertScope(trx,data);const job=await trx('o_v04StudioAssetDraftJob').where({id:data.jobId,projectId:data.projectId,scriptId:data.scriptId}).first();if(!job||!(job.generationIntent==='ASSET_IMAGE_EDIT'||JSON.parse(job.inputSnapshotJson).autoVersion))throw new PilotError('PILOT_SCOPE_INVALID','候选不存在',404);
 const accepted=await trx('o_v04Decision').where({projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectKey:job.id,status:'ACCEPTED'}).first();if(accepted)throw new PilotError('PILOT_CANDIDATE_ACCEPTED','已采用的参考不能通过放弃候选撤销',409);
 const existing=await trx('o_v04Decision').where({projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectKey:job.id,status:'REJECTED'}).first();if(existing)return {rejected:true};
 await trx('o_v04Decision').insert({id:randomUUID(),projectId:data.projectId,scriptId:data.scriptId,category:'ASSET_IMAGE_EDIT',subjectType:'ASSET',subjectKey:job.id,content:JSON.stringify({canonicalKey:job.canonicalKey}),status:'REJECTED',sourceMessageIds:'[]',supersedesDecisionId:null,createdAt:Date.now(),acceptedAt:null});return {rejected:true};
});}

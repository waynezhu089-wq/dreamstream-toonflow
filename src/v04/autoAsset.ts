import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Knex} from 'knex';
import {z} from 'zod';
import {db} from '@/utils/db';
import getPath from '@/utils/getPath';
import {PilotError} from './service';
import {visualSpecSchema} from './visualSpecContract';
import {compileStudioDraftPromptsInTransaction} from './visualSpec';
import {baselinesInTransaction,suitableBaseline} from './assetImageBaseline';
import {currentRouting,resolveEditRouting} from './operations';
import {buildKreaEditWorkflow,KREA_EDIT_WORKFLOW_VERSION,uploadEditInput} from './kreaImageEditProfile';
import {awaitDraft,downloadDraft,DraftComfyError,localComfyOrigin} from './comfyDraftClient';
import {submitTracedDraft,failSubmittedTrace} from './tracedDraftSubmit';
import {settleJobTraces} from './executionTrace';
import {getAgentAttachmentBytes} from './agentAttachments';
import {AUTO_ASSET_RECONCILER_V1,KREA2_ASSET_T2I_RENDERING_V1,autoAssetPriority,autoAssetRoles,autoAssetResolution,autoAssetPrompt} from './autoAssetPrompt';
const q=db as Knex;
const scope=z.object({projectId:z.number().int().positive(),scriptId:z.number().int().positive()}).strict();
const request=scope.extend({items:z.array(z.object({canonicalKey:z.string().min(1).max(128),sourceAssetRevision:z.number().int().positive(),spec:visualSpecSchema}).strict()).max(200).default([]),
  regenerateKey:z.string().min(1).max(128).optional(),requestId:z.string().uuid().optional()}).strict();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eligible=(a:any)=>a.status==='ACTIVE'&&a.sourcePolicy==='AI_ALLOWED'&&!['BRAND','UI'].includes(a.category)&&!['BRAND_MARK','UI_REFERENCE'].includes(a.assetKind);
function snapshot(row:any){try{return JSON.parse(row.inputSnapshotJson);}catch{return null;}}
export async function captureAutoAssetReadContext(trx:Knex.Transaction,s:{projectId:number;scriptId:number}){
  if(!await trx('o_script').where({id:s.scriptId,projectId:s.projectId}).first())throw new PilotError('PILOT_SCOPE_INVALID','制作单元不存在',404);
  const assets=await trx('o_v04Asset').where({projectId:s.projectId,status:'ACTIVE'}).orderBy('canonicalKey').limit(201);
  if(assets.length>200)throw new PilotError('PILOT_ASSET_LIMIT','资产数量超过本次自动准备范围',422);
  const jobs=await trx('o_v04StudioAssetDraftJob').where(s).orderBy('createdAt','desc').orderBy('id','desc').limit(2001);
  if(jobs.length>2000)throw new PilotError('PILOT_JOB_LIMIT','草图历史过多，请联系管理人员',422);
  const specs=await trx('o_v04AssetVisualSpec').where({projectId:s.projectId,status:'CONFIRMED'}).orderBy('revision','desc').limit(2001);
  if(specs.length>2000)throw new PilotError('PILOT_SPEC_LIMIT','视觉规格历史超过本次读取范围',422);
  const baselines=(await baselinesInTransaction(trx,s)).filter(b=>assets.some(a=>a.canonicalKey===b.canonicalKey&&a.revision===b.sourceAssetRevision));
  const creative=await trx('o_v04Creative').where(s).first();
  const config=await trx('o_v04StudioImageExecutorConfig').where({projectId:s.projectId}).first();
  const routing=await currentRouting(trx,s.projectId);
  return {assets,jobs,specs,baselines,creative,config,routing};
}
function mainSource(state:Awaited<ReturnType<typeof captureAutoAssetReadContext>>,asset:any){
  const baseline=suitableBaseline(state.baselines,asset.canonicalKey,'BODY');
  if(baseline)return {sourceAttachmentId:baseline.attachmentId,sourceArtifactId:null,sourceHash:baseline.sha256,baselineVersion:baseline.version};
  const job=state.jobs.find(j=>j.canonicalKey===asset.canonicalKey&&j.sourceAssetRevision===asset.revision&&j.status==='SUCCEEDED'&&
    JSON.parse(j.outputsJson).some((o:any)=>o.role==='MAIN_PREVIEW')&&(!j.executionPurpose||['ASSET_MAIN_PREVIEW','SUBJECT_MAIN_PREVIEW'].includes(j.executionPurpose))&&
    (!snapshot(j)?.autoVersion||(snapshot(j).assetEvidence===digest(asset)&&snapshot(j).creativeEvidence===digest(state.creative)&&snapshot(j).confirmedSpecEvidence===(state.specs.find(s=>s.canonicalKey===asset.canonicalKey&&s.sourceAssetRevision===asset.revision)?.specJson??null))));
  if(!job)return null;
  return {sourceArtifactId:JSON.parse(job.outputsJson).find((o:any)=>o.role==='MAIN_PREVIEW').artifactId,
    sourceAttachmentId:null,sourceHash:job.draftHash,sourceJobId:job.id,baselineVersion:null};
}
export function preparedSpec(state:Awaited<ReturnType<typeof captureAutoAssetReadContext>>,asset:any,items:any[]){
  const provided=items.find(i=>i.canonicalKey===asset.canonicalKey&&i.sourceAssetRevision===asset.revision);
  if(provided)return provided.spec;
  const confirmed=state.specs.find(s=>s.canonicalKey===asset.canonicalKey&&s.sourceAssetRevision===asset.revision);
  if(confirmed)return JSON.parse(confirmed.specJson);
  const stored=state.jobs.find(j=>j.canonicalKey===asset.canonicalKey&&j.sourceAssetRevision===asset.revision&&snapshot(j)?.visualSpecDraft);
  return stored?snapshot(stored).visualSpecDraft:null;
}
export async function reconcileAutoAssets(input:unknown){
  const data=request.parse(input);
  if(new Set(data.items.map(i=>i.canonicalKey)).size!==data.items.length)throw new PilotError('PILOT_VISUAL_DUPLICATE_KEY','同一资产草案不能重复',422);
  if(data.regenerateKey&&!data.requestId)throw new PilotError('PILOT_REQUEST_ID_REQUIRED','重新准备需要请求标识',400);
  return q.transaction(async trx=>{
    // Acquire the SQLite write boundary before checking dedupe and sources.
    await trx('o_script').where({id:data.scriptId,projectId:data.projectId}).update({id:data.scriptId});
    const state=await captureAutoAssetReadContext(trx,{projectId:data.projectId,scriptId:data.scriptId}),results:any[]=[];
    const assets=[...state.assets].sort((a,b)=>autoAssetPriority(a)-autoAssetPriority(b)||a.canonicalKey.localeCompare(b.canonicalKey));
    const add=async(asset:any,spec:any,purpose:string,source:any)=>{
      let route;
      try{route=await resolveEditRouting(trx,data.projectId,purpose==='ASSET_MAIN_PREVIEW'?'T2I':'DERIVE_VIEW');}
      catch(e){if(e instanceof PilotError)return {canonicalKey:asset.canonicalKey,status:'PAUSED',code:e.code};throw e;}
      const profile=purpose==='ASSET_MAIN_PREVIEW'?route.profile:asset.assetKind==='HUMAN_CHARACTER'?route.profile:'KREA2_DERIVE_ASSET_REFERENCE_V1';
      if(state.routing.disabledProfiles.includes(profile))return {canonicalKey:asset.canonicalKey,status:'PAUSED',code:'PILOT_IMAGE_ROUTING_DISABLED'};
      if(purpose==='ASSET_MAIN_PREVIEW'&&profile!=='KREA2_T2I_ASSET_V1')throw new PilotError('PILOT_ROUTE_INCOMPATIBLE','第一稿执行器不兼容',409);
      const compiled=await compileStudioDraftPromptsInTransaction(trx,{projectId:data.projectId,scriptId:data.scriptId,items:[{canonicalKey:asset.canonicalKey,sourceAssetRevision:asset.revision,spec}]});
      if(compiled.failures.length)return {canonicalKey:asset.canonicalKey,status:'WAITING_PREPARATION',code:compiled.failures[0].code};
      const c=compiled.candidates[0],resolution=autoAssetResolution(asset.assetKind);
      let sourceSha256=source.sourceHash??null;
      if(source.sourceArtifactId){const file=await trx('o_v04StudioDraftArtifact').where({artifactId:source.sourceArtifactId,projectId:data.projectId}).first();
        if(!file)return {canonicalKey:asset.canonicalKey,status:'WAITING_PREPARATION',code:'SOURCE_MISSING'};
        try{sourceSha256=createHash('sha256').update(await fs.readFile(getPath(['v04-draft-artifacts',String(data.projectId),`${file.artifactId}.${file.extension}`]))).digest('hex');}
        catch{return {canonicalKey:asset.canonicalKey,status:'WAITING_PREPARATION',code:'SOURCE_MISSING'};}}
      const frozen={autoVersion:AUTO_ASSET_RECONCILER_V1,renderingLanguageVersion:KREA2_ASSET_T2I_RENDERING_V1,
        visualSpecDraft:spec,draftPromptIR:c.draftPromptIR,asset: {canonicalKey:asset.canonicalKey,revision:asset.revision,assetKind:asset.assetKind,importance:asset.importance},
        assetEvidence:digest(asset),creativeEvidence:digest(state.creative),routingVersion:route.routingVersion,
        baseUrl:localComfyOrigin(state.config?.baseUrl??'http://127.0.0.1:8188'),executionPurpose:purpose,...source,sourceSha256,
        confirmedSpecEvidence:state.specs.find(row=>row.canonicalKey===asset.canonicalKey&&row.sourceAssetRevision===asset.revision)?.specJson??null,
        executionPrompt:autoAssetPrompt(asset,spec,state.creative,purpose),...resolution,
        regenerationId:data.regenerateKey===asset.canonicalKey&&purpose==='ASSET_MAIN_PREVIEW'?data.requestId:null};
      const draftHash=digest({frozen,profile,workflowVersion:KREA_EDIT_WORKFLOW_VERSION});
      const previous=state.jobs.find(j=>j.canonicalKey===asset.canonicalKey&&j.draftHash===draftHash);
      // Failed/uncertain work is never silently resubmitted on reload.
      if(previous)return {canonicalKey:asset.canonicalKey,status:previous.status,jobId:previous.id,reused:true};
      const now=Date.now(),job={id:randomUUID(),projectId:data.projectId,scriptId:data.scriptId,canonicalKey:asset.canonicalKey,
        sourceAssetRevision:asset.revision,draftHash,generationIntent:c.generationIntent,executionPurpose:purpose,executorType:'COMFY_LOCAL',executorProfile:profile,
        workflowVersion:KREA_EDIT_WORKFLOW_VERSION,status:'QUEUED',comfyPromptId:null,inputSnapshotJson:JSON.stringify({...frozen,seed:parseInt(draftHash.slice(0,12),16)}),
        outputsJson:'[]',errorCode:null,errorMessage:null,attemptCount:1,createdAt:now,updatedAt:now,startedAt:null,completedAt:null};
      await trx('o_v04StudioAssetDraftJob').insert(job);state.jobs.unshift(job);
      return {canonicalKey:asset.canonicalKey,status:'QUEUED',jobId:job.id,reused:false};
    };
    // First-draft admission is a complete phase before any pack admission.
    for(const asset of assets){
      if(!eligible(asset)){results.push({canonicalKey:asset.canonicalKey,status:'REAL_REQUIRED'});continue;}
      const main=mainSource(state,asset);
      const provided=data.items.find(i=>i.canonicalKey===asset.canonicalKey&&i.sourceAssetRevision===asset.revision);
      const priorSpec=main&&'sourceJobId' in main?snapshot(state.jobs.find(j=>j.id===main.sourceJobId))?.visualSpecDraft:null;
      const changedDraft=provided&&priorSpec&&digest(provided.spec)!==digest(priorSpec);
      if(main&&!changedDraft&&data.regenerateKey!==asset.canonicalKey){results.push({canonicalKey:asset.canonicalKey,status:'READY',reused:true});continue;}
      const spec=preparedSpec(state,asset,data.items);
      results.push(spec?await add(asset,spec,'ASSET_MAIN_PREVIEW',{}):{canonicalKey:asset.canonicalKey,status:'WAITING_PREPARATION'});
    }
    const firstPending=state.jobs.some(j=>j.executionPurpose==='ASSET_MAIN_PREVIEW'&&['QUEUED','RUNNING'].includes(j.status));
    if(!firstPending)for(const asset of assets){
      if(!eligible(asset))continue;const source=mainSource(state,asset),spec=preparedSpec(state,asset,data.items);
      if(!source||!spec)continue;
      for(const purpose of autoAssetRoles(asset))results.push({...await add(asset,spec,purpose,source),purpose});
    }
    return {version:AUTO_ASSET_RECONCILER_V1,results};
  });
}
export async function autoJobFresh(job:any,trx:Knex|Knex.Transaction=q,captured?:Awaited<ReturnType<typeof captureAutoAssetReadContext>>):Promise<boolean>{
 const s=snapshot(job);if(!s?.autoVersion)return true;
 if(trx===q)return q.transaction(t=>autoJobFresh(job,t));
 const state=captured??await captureAutoAssetReadContext(trx as Knex.Transaction,{projectId:job.projectId,scriptId:job.scriptId});
 const asset=state.assets.find(a=>a.canonicalKey===job.canonicalKey);
 if(!asset||!eligible(asset)||digest(asset)!==s.assetEvidence||digest(state.creative)!==s.creativeEvidence)return false;
 const spec=state.specs.find(row=>row.canonicalKey===job.canonicalKey&&row.sourceAssetRevision===job.sourceAssetRevision);
 if((spec?.specJson??null)!==s.confirmedSpecEvidence)return false;
 if(s.sourceArtifactId||s.sourceAttachmentId){const current=mainSource(state,asset);
  if(!current||current.sourceArtifactId!==s.sourceArtifactId||current.sourceAttachmentId!==s.sourceAttachmentId||current.sourceHash!==s.sourceHash||current.baselineVersion!==s.baselineVersion)return false;}
 return true;
}
export async function autoAssetCoverage(input:unknown){
  const s=scope.parse(input);
  return q.transaction(async trx=>{
    const state=await captureAutoAssetReadContext(trx,s),items=[];
    for(const asset of state.assets){
      const first=state.jobs.find(j=>j.canonicalKey===asset.canonicalKey&&j.sourceAssetRevision===asset.revision&&j.executionPurpose==='ASSET_MAIN_PREVIEW');
      const roles=autoAssetRoles(asset),source=mainSource(state,asset);
      const packs=state.jobs.filter(j=>j.canonicalKey===asset.canonicalKey&&j.sourceAssetRevision===asset.revision&&roles.includes(j.executionPurpose));
      const current:any[]=[];for(const j of packs)if(await autoJobFresh(j,trx,state))current.push(j);
      items.push({canonicalKey:asset.canonicalKey,kind:asset.assetKind,realRequired:!eligible(asset),
        firstDraftStatus:source?'READY':first?.status??'WAITING_PREPARATION',firstJobId:first?.id??null,
        packRoles:roles,packReady:roles.filter(r=>current.some(j=>j.executionPurpose===r&&j.status==='SUCCEEDED')),
        packRunning:roles.filter(r=>current.some(j=>j.executionPurpose===r&&['QUEUED','RUNNING'].includes(j.status)))});
    }
    return {active:items.length,aiAllowed:items.filter(a=>!a.realRequired).length,realRequired:items.filter(a=>a.realRequired).length,
      firstDraftReady:items.filter(a=>a.firstDraftStatus==='READY').length,firstDraftRunning:items.filter(a=>['QUEUED','RUNNING'].includes(a.firstDraftStatus)).length,
      firstDraftFailed:items.filter(a=>a.firstDraftStatus==='FAILED').length,corePackReady:items.filter(a=>a.packRoles.length&&a.packReady.length===a.packRoles.length).length,
      corePackRunning:items.filter(a=>a.packRunning.length).length,items};
  });
}
export async function produceAutoAsset(job:any,freshClaim:boolean){
  const s=snapshot(job);let paused=false;
  try{
    if(!freshClaim&&!job.comfyPromptId)throw new DraftComfyError('EXECUTION_UNCERTAIN','上次交付结果不确定，需要人工检查');
    if(!await autoJobFresh(job)){
      await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:'STALE',updatedAt:Date.now()});return;
    }
    const base=localComfyOrigin(s.baseUrl);
    if(!job.comfyPromptId){
      const routing=await currentRouting(q,job.projectId);
      if(routing.disabledProfiles.includes(job.executorProfile)){paused=true;return;}
      try{const r=await fetch(base+'/system_stats',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!r.ok){paused=true;return;}}
      catch{paused=true;return;}
    }
    let sourceImage:string|undefined;
    if(s.sourceAttachmentId){const file=await getAgentAttachmentBytes(job.projectId,s.sourceAttachmentId);if(createHash('sha256').update(file.bytes).digest('hex')!==s.sourceHash)throw new DraftComfyError('STALE_JOB','源图已变化');sourceImage=await uploadEditInput(base,file.bytes,'auto_'+job.id+'.png');}
    else if(s.sourceArtifactId){const a=await q('o_v04StudioDraftArtifact').where({artifactId:s.sourceArtifactId,projectId:job.projectId}).first();if(!a)throw new DraftComfyError('SOURCE_MISSING','源图不存在');const bytes=await fs.readFile(getPath(['v04-draft-artifacts',String(job.projectId),`${a.artifactId}.${a.extension}`]));if(createHash('sha256').update(bytes).digest('hex')!==s.sourceSha256)throw new DraftComfyError('STALE_JOB','源图已变化');sourceImage=await uploadEditInput(base,bytes,'auto_'+job.id+'.png');}
    const workflow=buildKreaEditWorkflow({profile:job.executorProfile,prompt:s.executionPrompt,seed:s.seed,width:s.width,height:s.height,sourceImage,targetRole:job.executionPurpose==='ASSET_MAIN_PREVIEW'?'MAIN_PREVIEW':job.executionPurpose,jobId:job.id});
    const promptId=job.comfyPromptId??await submitTracedDraft(base,workflow,job);
    job.comfyPromptId=promptId;await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({comfyPromptId:promptId,updatedAt:Date.now()});
    const downloaded=await downloadDraft(base,await awaitDraft(base,promptId,workflow.outputNode,900000));
    const artifactId=randomUUID(),createdAt=Date.now(),file=getPath(['v04-draft-artifacts',String(job.projectId),`${artifactId}.${downloaded.extension}`]);
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,downloaded.bytes,{flag:'wx'});
    const artifact={artifactId,role:workflow.role,mimeType:downloaded.mimeType,width:downloaded.width,height:downloaded.height,createdAt,fileRef:`/api/v04/studio/artifact/${job.projectId}/${artifactId}`};
    await q.transaction(async trx=>{
      await trx('o_v04StudioDraftArtifact').insert({artifactId,jobId:job.id,projectId:job.projectId,role:workflow.role,mimeType:downloaded.mimeType,extension:downloaded.extension,width:downloaded.width,height:downloaded.height,createdAt});
      await trx('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:await autoJobFresh(job,trx)?'SUCCEEDED':'STALE',outputsJson:JSON.stringify([artifact]),completedAt:createdAt,updatedAt:createdAt});
    });
  }catch(error){
    const failure=error instanceof DraftComfyError?error:new DraftComfyError('EXECUTION_FAILED','图片准备失败');
    await failSubmittedTrace(job,failure.code);
    if(failure.code==='OUT_OF_MEMORY'&&job.attemptCount===1){
      const retry={...s,width:512,height:512};
      const changed=await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:'QUEUED',comfyPromptId:null,attemptCount:2,inputSnapshotJson:JSON.stringify(retry),updatedAt:Date.now()});
      if(changed)return;
    }
    await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:'FAILED',errorCode:failure.code,errorMessage:failure.message,completedAt:Date.now(),updatedAt:Date.now()});
  }finally{
    if(paused){await q('o_v04StudioAssetDraftJob').where({id:job.id,status:'RUNNING'}).update({status:'QUEUED',errorCode:'PAUSED',errorMessage:'图片准备暂时暂停。',startedAt:null,updatedAt:Date.now()});}
    await settleJobTraces(job.id);
    if(paused)return {paused:true};
  }
  return {paused};
}

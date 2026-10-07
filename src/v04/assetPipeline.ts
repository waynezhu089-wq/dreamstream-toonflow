import {randomUUID} from 'node:crypto';
import type {Knex} from 'knex';
import {z} from 'zod';
import {db} from '@/utils/db';
import {PilotError,newAsset,readPilot,previewAssets,applyAssets} from './service';
import {previewSkill} from './skills';
import {proposeVisualSpecs} from './visualSpec';
import {proposeDirector,captureCurrentDirectorForExperiment} from './directorBible';
import {captureAutoAssetReadContext,preparedSpec,reconcileAutoAssetsInTransaction,autoAssetCoverage} from './autoAsset';
import {wakeDraftWorker} from './studioDraftImage';
const q=db as Knex;
const scopeSchema=z.object({projectId:z.number().int().positive(),scriptId:z.number().int().positive()}).strict();
const category='ASSET_PIPELINE_SETUP';
function initialOwnerAlive(row:any){
 try{const pid=JSON.parse(row.content).ownerPid;if(!Number.isInteger(pid)||pid<=0)return true;process.kill(pid,0);return true;}
 catch(e:any){return e?.code!=='ESRCH';}
}
async function authorize(scope:any,actor:number){const p=await q('o_project').where({id:scope.projectId,userId:actor}).first();if(!p||!await q('o_script').where({id:scope.scriptId,projectId:scope.projectId}).first())throw new PilotError('PILOT_FORBIDDEN','无权访问这个项目',403);}
async function journal(scope:any,phase:string,detail:any={},writer:Knex|Knex.Transaction=q){
 const row={id:randomUUID(),...scope,category,subjectType:'PROJECT',subjectKey:String(scope.projectId),status:phase,content:JSON.stringify({phase,...detail}),sourceMessageIds:'[]',supersedesDecisionId:null,createdAt:Date.now(),acceptedAt:null};
 await writer('o_v04Decision').insert(row);return row;
}
// Append-only phase journal on existing storage, not a general task subsystem.
export async function prepareInitialProject(input:unknown,actor:number){
 const scope=scopeSchema.parse(input);await authorize(scope,actor);
 const claim=await q.transaction(async trx=>{await trx('o_script').where({id:scope.scriptId,projectId:scope.projectId}).update({id:scope.scriptId});
   const prior=await trx('o_v04Decision').where({...scope,category}).orderBy('createdAt','desc').orderBy('id','desc').first();
   if(prior&&!(prior.status==='ATTENTION'||prior.status==='INITIAL_STARTED'&&Date.now()-prior.createdAt>1800000&&!initialOwnerAlive(prior)))return false;
   await trx('o_v04Decision').insert({id:randomUUID(),...scope,category,subjectType:'PROJECT',subjectKey:String(scope.projectId),status:'INITIAL_STARTED',content:JSON.stringify({ownerPid:process.pid}),sourceMessageIds:'[]',supersedesDecisionId:null,createdAt:Date.now(),acceptedAt:null});return true;});
 if(!claim)return {accepted:true,replayed:true};
 void (async()=>{try{
   const state=await readPilot(scope);
   if(!state.assets.length){const result:any=await previewSkill({...scope,method:'ASSET_EXTRACTION'},true);
     const merge=new Set(result.output.mergeSuggestions.map((m:any)=>m.candidateIndex));
     const refs=result.output.candidates.map((_:any,i:number)=>'initial-'+i);
     const changes=result.output.candidates.flatMap((a:any,i:number)=>{if(merge.has(i))return [];const {relatedCandidateIndexes,relatedExistingKeys,sharedVisualSystemCandidateIndex}=a;
       const asset=newAsset.parse({...Object.fromEntries(Object.keys(newAsset.shape).filter(k=>k in a).map(k=>[k,a[k]])),relatedKeys:relatedExistingKeys??[]});
       return [{operation:'ADD',clientRef:refs[i],asset,relatedClientRefs:(relatedCandidateIndexes??[]).filter((n:number)=>!merge.has(n)).map((n:number)=>refs[n]),sharedVisualSystemClientRef:sharedVisualSystemCandidateIndex!==null&&!merge.has(sharedVisualSystemCandidateIndex)?refs[sharedVisualSystemCandidateIndex]:null}];});
     const coverage=result.output.coverage.map((c:any)=>{const {candidateIndexes,...rest}=c;return {...rest,candidateRefs:candidateIndexes.filter((i:number)=>!merge.has(i)).map((i:number)=>refs[i]),existingCanonicalKeys:[...c.existingCanonicalKeys,...candidateIndexes.filter((i:number)=>merge.has(i)).map((i:number)=>result.output.mergeSuggestions.find((m:any)=>m.candidateIndex===i).existingCanonicalKey)]};});
     const body={...scope,sourceCreativeVersion:result.sourceVersion,changes,coverage};
     const preview=await previewAssets(body);await applyAssets({...body,previewHash:preview.previewHash});
   }
   const project=await q('o_project').where({id:scope.projectId}).first();
   const proposal=await proposeDirector({...scope,userInstruction:project.artStyle||'根据项目故事形成视觉方向，保持已确认身份'},actor);
   await journal(scope,'DIRECTOR_REVIEW',{proposalId:proposal.id,automaticPreparation:true});
 }catch(e:any){await journal(scope,'ATTENTION',{errorCode:e instanceof PilotError?e.code:'PROJECT_PREPARATION_FAILED'});}})();
 return {accepted:true};
}
export async function generateAllAssets(input:unknown,actor:number){
 const data=scopeSchema.extend({regenerate:z.boolean().default(false),requestId:z.string().uuid().optional(),canonicalKey:z.string().max(128).optional()}).strict().parse(input);const scope={projectId:data.projectId,scriptId:data.scriptId};await authorize(scope,actor);
 if(data.canonicalKey&&!await q('o_v04Asset').where({projectId:scope.projectId,canonicalKey:data.canonicalKey,status:'ACTIVE'}).first())throw new PilotError('PILOT_TARGET_INVALID','素材不属于当前项目',404);
 if(data.regenerate&&!data.requestId)throw new PilotError('PILOT_REQUEST_ID_REQUIRED','重新准备需要请求标识',400);
 if(!await q('o_v04DirectorVersion').where({projectId:scope.projectId}).first()){
   const initial=await q('o_v04Decision').where({...scope,category,status:'INITIAL_STARTED'}).first();
   if(initial)return prepareInitialProject(scope,actor);
 }
 const director=await q.transaction(trx=>captureCurrentDirectorForExperiment(trx,scope));
 const preparationId=randomUUID();
 const claimed=await q.transaction(async trx=>{await trx('o_script').where({id:scope.scriptId,projectId:scope.projectId}).update({id:scope.scriptId});
 const latest=await trx('o_v04Decision').where({...scope,category}).orderBy('createdAt','desc').orderBy('id','desc').first();
 if(latest?.status==='PREPARING'&&Date.now()-latest.createdAt<1800000)return false;
 const sameRequest=data.requestId?await trx('o_v04Decision').where({...scope,category}).whereRaw("json_extract(content, '$.requestId') = ?",[data.requestId]).first():null;if(sameRequest)return false;
 const prior=await trx('o_v04Decision').where({...scope,category,status:'ADMITTED'}).whereRaw("json_extract(content, '$.directorRevision') = ?",[director.current.directorVersion]).first();if(prior&&!data.regenerate)return false;
 await trx('o_v04Decision').insert({id:preparationId,...scope,category,subjectType:'PROJECT',subjectKey:String(scope.projectId),status:'PREPARING',content:JSON.stringify({directorRevision:director.current.directorVersion,requestId:data.requestId??null}),sourceMessageIds:'[]',supersedesDecisionId:null,createdAt:Date.now(),acceptedAt:null});return true;});
 if(!claimed)return {accepted:true,inProgress:true};
 void (async()=>{const failures:any[]=[];try{
   const context=await q.transaction(trx=>captureAutoAssetReadContext(trx,scope));
   const eligible=context.assets.filter(a=>(!data.canonicalKey||a.canonicalKey===data.canonicalKey)&&a.sourcePolicy==='AI_ALLOWED'&&!['BRAND','UI'].includes(a.category));
   const missing=eligible.filter(a=>!preparedSpec(context,a,[]));
   const items:any[]=[];
   for(let i=0;i<missing.length;i+=6){const keys=missing.slice(i,i+6).map(a=>a.canonicalKey);
     try{const result=await proposeVisualSpecs({...scope,canonicalKeys:keys});items.push(...result.candidates.map(c=>({canonicalKey:c.canonicalKey,sourceAssetRevision:c.sourceAssetRevision,spec:c.spec})));failures.push(...result.failures.map(f=>({canonicalKey:f.canonicalKey,code:f.code})));}
     catch(e:any){failures.push(...keys.map(canonicalKey=>({canonicalKey,code:e instanceof PilotError?e.code:'VISUAL_PREPARATION_FAILED'})));}}
   await q.transaction(async trx=>{
     await trx('o_script').where({id:scope.scriptId,projectId:scope.projectId}).update({id:scope.scriptId});
     const head=await trx('o_v04Decision').where({...scope,category}).orderBy('createdAt','desc').orderBy('id','desc').first();if(head?.id!==preparationId)return;
     const current=await captureCurrentDirectorForExperiment(trx,scope);
     if(current.current.id!==director.current.id)throw new PilotError('DIRECTOR_SOURCE_STALE','视觉方向已变化，请重新准备',409);
     const results={results:[] as any[]};if(data.regenerate){for(const asset of eligible){const one=await reconcileAutoAssetsInTransaction(trx,{...scope,items,canonicalKeys:[asset.canonicalKey],regenerateKey:asset.canonicalKey,requestId:data.requestId});results.results.push(...one.results);}}else results.results.push(...(await reconcileAutoAssetsInTransaction(trx,{...scope,items})).results);
     await journal(scope,'ADMITTED',{directorRevision:director.current.directorVersion,requestId:data.requestId??null,failures,results:results.results},trx);
   });wakeDraftWorker();
 }catch(e:any){await q.transaction(async trx=>{
   await trx('o_script').where({id:scope.scriptId,projectId:scope.projectId}).update({id:scope.scriptId});
   const head=await trx('o_v04Decision').where({...scope,category}).orderBy('createdAt','desc').orderBy('id','desc').first();
   if(head?.id===preparationId)await journal(scope,'ATTENTION',{failures,errorCode:e instanceof PilotError?e.code:'ASSET_PREPARATION_FAILED'},trx);
 });}})();
 return {accepted:true};
}
export async function assetPipelineState(input:unknown,actor:number){const scope=scopeSchema.parse(input);await authorize(scope,actor);
 const rows=await q('o_v04Decision').where({...scope,category}).orderBy('createdAt','desc').orderBy('id','desc').limit(30);
 return {latest:rows[0]?{...JSON.parse(rows[0].content),phase:rows[0].status}:null,coverage:await autoAssetCoverage(scope),history:rows.map(r=>({id:r.id,phase:r.status,createdAt:r.createdAt,detail:JSON.parse(r.content)}))};}

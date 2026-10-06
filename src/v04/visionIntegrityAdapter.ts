import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import u from '@/utils';
import {requireModel,resolveModels} from '@/services/modelPreset';
import {inspection,integrityIssue} from './assetIntegrity';
import {db} from '@/utils/db';
import {inspectionDerivatives,strictVisionJson,visionError,visionTimeouts,VISION_TRANSPORT_VERSION,VISION_PREFLIGHT_VERSION} from './visionCapability';
export async function integrityVisionConfiguration(projectId:number){
 const {models}=await resolveModels(projectId),model=models.vision;if(!model)throw Error('VISION_CONFIG_MISSING');const id=model.split(':')[0];
 const signature=async()=>{const config=await db('o_vendorConfig').where({id}).first();if(!config||config.enable!==1)throw Error('VISION_CONFIG_MISSING');return hash({model,config,code:u.vendor.getCode(id),version:VISION_TRANSPORT_VERSION,preflightVersion:VISION_PREFLIGHT_VERSION});};
 return {model,signature:await signature()};
}
export async function prepareIntegrityVision(projectId:number){
 await requireModel(projectId,'vision');const {model,signature:before}=await integrityVisionConfiguration(projectId),session=await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).trackedSession();if(before!==(await integrityVisionConfiguration(projectId)).signature)throw Error('VISION_CONFIG_CHANGED');
 return {model,session,signature:before};
}
export const VISION_INTEGRITY_VERSION='integrity.vision-adapter.1';
const modelReport=inspection.extend({issues:z.array(integrityIssue.omit({id:true})).max(20),confidence:z.enum(['LOW','MEDIUM','HIGH'])}).strict();
const schema=z.object({SIDE:modelReport,BACK:modelReport,CROSS_VIEW:modelReport}).strict();
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function inspectIntegrityVision(projectId:number,brief:any,images:{view:string;bytes:Buffer;mimeType:string}[],options?:{prepared:Awaited<ReturnType<typeof prepareIntegrityVision>>;transportMode:'NATIVE'|'JSON_TEXT';targetView:'SIDE'|'BACK'|'ALL'}){
 const started=Date.now(),correlationId=randomUUID();let model='UNCONFIGURED';
 try{const prepared=options?.prepared??await prepareIntegrityVision(projectId);model=prepared.model;const session=prepared.session;const derivatives=await inspectionDerivatives(images);const target=options?.targetView??'ALL',selected=target==='ALL'?derivatives:derivatives.filter(i=>i.view==='MAIN'||i.view===target);const resultSchema=target==='ALL'?schema:z.object({[target]:modelReport}).strict();
  const content:any[]=[{type:'text',text:JSON.stringify(brief)}];for(const image of selected){content.push({type:'text',text:`Image view: ${image.view}`},{type:'image',image:image.bytes,mediaType:image.mimeType});}
  const request={schema:resultSchema,maxRetries:0,abortSignal:AbortSignal.timeout(visionTimeouts.inspection),system:'Inspect only structural coherence, identity and cross-view continuity. Reference image identity is authoritative; confirmed fictional structure overrides ordinary priors. Not visible is not missing. Do not judge atmosphere or cinematic quality. Report uncertainty conservatively. Provide the strict structured report for SIDE/BACK/CROSS_VIEW; do not invent expected defects. Each issue must cite actual evidence views. No repair execution or acceptance.',messages:[{role:'user' as const,content}]};
  request.system+=` Return only ${target==='ALL'?'SIDE/BACK/CROSS_VIEW':target} report keys.`;
  const response=options?.transportMode==='JSON_TEXT'?await session.invoke({...request,system:request.system+' Reply with exactly one JSON object, no markdown.'}):await session.invokeObject(request);
  const parsed:any=resultSchema.parse(options?.transportMode==='JSON_TEXT'?strictVisionJson((response as any).text):(response as any).object),reports=Object.fromEntries(Object.entries(parsed).map(([view,r]:[string,any])=>[view,{...r,issues:r.issues.map((issue:any)=>({...issue,id:randomUUID()}))}]));
  for(const [view,r] of Object.entries(reports))for(const issue of r.issues)if(view==='CROSS_VIEW'?(issue.category!=='CROSS_VIEW'||new Set(issue.evidenceViews).size<2):!issue.evidenceViews.includes(view as 'SIDE'|'BACK'))throw Error('VISION_EVIDENCE_INVALID');
  const usage:any=response.usage;
  return {status:'SUCCEEDED',reports,audit:{version:VISION_INTEGRITY_VERSION,configSignature:prepared.signature,derivatives:derivatives.map(i=>i.audit),targetView:target,transportMode:options?.transportMode??'NATIVE',correlationId,modelRole:'vision',providerId:model.split(':')[0].replace(/[^\w.-]/g,'').slice(0,80),modelName:model.split(':').slice(1).join(':').replace(/[^\w.\/-]/g,'').slice(0,120),briefHash:hash(brief),responseHash:hash(parsed),latencyMs:Date.now()-started,usage:usage?Object.fromEntries(['inputTokens','outputTokens','totalTokens'].filter(k=>Number.isFinite(usage[k])).map(k=>[k,usage[k]])):null,cost:null}};
 }catch(error:any){const code=visionError(error,'inspection');console.error('[V04 Integrity]',{correlationId,errorCode:code,errorName:String(error?.name??'Error').replace(/[^\w.-]/g,'').slice(0,80)});
  return {status:'FAILED',reports:null,audit:{version:VISION_INTEGRITY_VERSION,correlationId,errorCode:code,briefHash:hash(brief),responseHash:null,latencyMs:Date.now()-started,modelRole:'vision',providerId:model.split(':')[0].replace(/[^\w.-]/g,'').slice(0,80),modelName:model.split(':').slice(1).join(':').replace(/[^\w.\/-]/g,'').slice(0,120),usage:null,cost:null}};
 }
}

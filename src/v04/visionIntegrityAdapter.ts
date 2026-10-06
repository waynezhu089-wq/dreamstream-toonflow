import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import u from '@/utils';
import {requireModel} from '@/services/modelPreset';
import {inspection,integrityIssue} from './assetIntegrity';
export const VISION_INTEGRITY_VERSION='integrity.vision-adapter.1';
const modelReport=inspection.extend({issues:z.array(integrityIssue.omit({id:true})).max(20),confidence:z.enum(['LOW','MEDIUM','HIGH'])}).strict();
const schema=z.object({SIDE:modelReport,BACK:modelReport,CROSS_VIEW:modelReport}).strict();
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function inspectIntegrityVision(projectId:number,brief:any,images:{view:string;bytes:Buffer;mimeType:string}[]){
 const started=Date.now(),correlationId=randomUUID();let model='UNCONFIGURED';
 try{model=await requireModel(projectId,'vision');const session=await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).trackedSession();
  const content:any[]=[{type:'text',text:JSON.stringify(brief)}];for(const image of images){content.push({type:'text',text:`Image view: ${image.view}`},{type:'image',image:image.bytes,mediaType:image.mimeType});}
  const response=await session.invokeObject({schema,maxRetries:0,abortSignal:AbortSignal.timeout(60000),system:'Inspect only structural coherence, identity and cross-view continuity. Reference image identity is authoritative; confirmed fictional structure overrides ordinary priors. Not visible is not missing. Do not judge atmosphere or cinematic quality. Report uncertainty conservatively. Provide the strict structured report for SIDE/BACK/CROSS_VIEW; do not invent expected defects. Each issue must cite actual evidence views. No repair execution or acceptance.',messages:[{role:'user',content}]});
  const parsed=schema.parse(response.object),reports=Object.fromEntries(Object.entries(parsed).map(([view,r])=>[view,{...r,issues:r.issues.map(issue=>({...issue,id:randomUUID()}))}]));
  for(const [view,r] of Object.entries(reports))for(const issue of r.issues)if(view==='CROSS_VIEW'?(issue.category!=='CROSS_VIEW'||new Set(issue.evidenceViews).size<2):!issue.evidenceViews.includes(view as 'SIDE'|'BACK'))throw Error('VISION_EVIDENCE_INVALID');
  const usage:any=response.usage;
  return {status:'SUCCEEDED',reports,audit:{version:VISION_INTEGRITY_VERSION,correlationId,modelRole:'vision',providerId:model.split(':')[0].replace(/[^\w.-]/g,'').slice(0,80),modelName:model.split(':').slice(1).join(':').replace(/[^\w.\/-]/g,'').slice(0,120),briefHash:hash(brief),responseHash:hash(parsed),latencyMs:Date.now()-started,usage:usage?Object.fromEntries(['inputTokens','outputTokens','totalTokens'].filter(k=>Number.isFinite(usage[k])).map(k=>[k,usage[k]])):null,cost:null}};
 }catch(error:any){const code=/Timeout|Abort/i.test(error?.name??'')?'INTEGRITY_VISION_TIMEOUT':/Zod|NoObject|JSON|TypeValidation/.test(error?.name??'')?'INTEGRITY_VISION_SCHEMA_FAILED':'INTEGRITY_VISION_FAILED';console.error('[V04 Integrity]',{correlationId,errorCode:code,errorName:String(error?.name??'Error').replace(/[^\w.-]/g,'').slice(0,80)});
  return {status:'FAILED',reports:null,audit:{version:VISION_INTEGRITY_VERSION,correlationId,errorCode:code,briefHash:hash(brief),responseHash:null,latencyMs:Date.now()-started,modelRole:'vision',providerId:model.split(':')[0].replace(/[^\w.-]/g,'').slice(0,80),modelName:model.split(':').slice(1).join(':').replace(/[^\w.\/-]/g,'').slice(0,120),usage:null,cost:null}};
 }
}

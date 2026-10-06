import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import sharp from 'sharp';
import u from '@/utils';
import {requireModel,resolveModels} from '@/services/modelPreset';
import {inspection} from './assetIntegrity';
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
export const VISION_INTEGRITY_VERSION='integrity.vision-adapter.2';
const minimalResponse=z.object({result:z.enum(['PASS','REPAIRABLE','REGENERATE','UNCERTAIN']),confidence:z.enum(['HIGH','MEDIUM','LOW']),issues:z.array(z.object({region:z.string().trim().min(1).max(100),problem:z.string().trim().min(1).max(1000),severity:z.enum(['MINOR','MODERATE','MAJOR']),localRepairable:z.boolean()}).strict()).max(8)}).strict().superRefine((r,ctx)=>{if(r.result==='PASS'&&r.issues.length||['REPAIRABLE','REGENERATE'].includes(r.result)&&!r.issues.length)ctx.addIssue({code:'custom',path:['issues'],message:'Result and issue evidence conflict'});});
export const MINIMAL_ESCALATION_VERSION='integrity.fine-brief.2';
export const FINE_DETAIL_VERSION='integrity.human-back-detail.1';
export const HUMAN_BACK_CHECKS=['HAND_ANATOMY_ORIENTATION','FOOT_TOE_HEEL_ORIENTATION','REAR_LIMB_JOINT_COHERENCE'] as const;
const fineIssue=z.object({region:z.string().trim().min(1).max(100),problem:z.string().trim().min(1).max(1000),severity:z.enum(['MINOR','MODERATE','MAJOR']),localRepairable:z.boolean()}).strict();
const fineResponse=z.object({checks:z.array(z.object({checkClass:z.enum(HUMAN_BACK_CHECKS),result:z.enum(['PASS','DEFECT','UNCERTAIN']),confidence:z.enum(['HIGH','MEDIUM','LOW']),issues:z.array(fineIssue).max(8)}).strict()).max(3)}).strict();
const isHumanBack=(brief:any,target:string)=>target==='BACK'&&brief.assetProfile==='HUMAN'&&HUMAN_BACK_CHECKS.every(c=>brief.requestedCheckClasses?.includes(c));
const byteHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Fixed centered full-body regions are observation windows, not defect annotations.
// Hands use separate left/right windows in cell 1; cells 2-4 retain lower-body context.
export async function humanBackDerivatives(image:{bytes:Buffer;mimeType:string}){
 const sourceTargetHash=byteHash(image.bytes),original=await sharp(image.bytes,{limitInputPixels:16000000}).rotate().flatten({background:'#ededed'}).png().toBuffer(),meta=await sharp(original).metadata(),width=meta.width!,height=meta.height!;
 const regions=[
  {region:'LEFT_ARM_EXTREMITY',check:HUMAN_BACK_CHECKS[0],bounds:[0.10,0.30,0.35,0.40],left:0,top:0,w:384,h:768},
  {region:'RIGHT_ARM_EXTREMITY',check:HUMAN_BACK_CHECKS[0],bounds:[0.55,0.30,0.35,0.40],left:384,top:0,w:384,h:768},
  {region:'FEET_HEELS',check:HUMAN_BACK_CHECKS[1],bounds:[0.15,0.78,0.70,0.22],left:768,top:0,w:768,h:768},
  {region:'REAR_LEGS_JOINTS',check:HUMAN_BACK_CHECKS[2],bounds:[0.20,0.48,0.60,0.40],left:0,top:768,w:768,h:768},
  {region:'LOWER_BODY_CONTEXT',check:HUMAN_BACK_CHECKS[2],bounds:[0.10,0.42,0.80,0.58],left:768,top:768,w:768,h:768}
 ];
 const crops=await Promise.all(regions.map(async r=>{
  const [x,y,w,h]=r.bounds,left=Math.floor(x*width),top=Math.floor(y*height),rect={left,top,width:Math.max(1,Math.min(width-left,Math.ceil(w*width))),height:Math.max(1,Math.min(height-top,Math.ceil(h*height)))};
  const bytes=await sharp(original).extract(rect).resize(r.w,r.h,{fit:'contain',background:'#ededed'}).png().toBuffer();
  return {input:bytes,left:r.left,top:r.top,audit:{check:r.check,region:r.region,normalizedBounds:r.bounds,sourceRect:rect,sourceTargetHash,outputHash:byteHash(bytes),outputDimensions:{width:r.w,height:r.h}}};
 }));
 const detail=await sharp({create:{width:1536,height:1536,channels:3,background:'#ededed'}}).composite(crops.map(({input,left,top})=>({input,left,top}))).jpeg({quality:92}).toBuffer();
 const full=await sharp(original).resize({width:768,height:768,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
 const images=await Promise.all([{view:'BACK_FULL',bytes:full},{view:'BACK_DETAIL',bytes:detail}].map(async i=>{const m=await sharp(i.bytes).metadata();return {...i,mimeType:'image/jpeg',audit:{view:i.view,sha256:byteHash(i.bytes),width:m.width,height:m.height,byteLength:i.bytes.length,version:FINE_DETAIL_VERSION}};}));
 return {images,audit:{fineDetailVersion:FINE_DETAIL_VERSION,sourceTargetHash,sourceDimensions:{width,height},sourceCoordinateSystem:'EXIF_AUTORIENTED',imageInputs:images.map(i=>i.view),detailCrops:crops.map(c=>c.audit)}};
}
export function mapFineInspection(input:unknown,brief:any){
 const r=fineResponse.parse(input),missingCheckClasses=HUMAN_BACK_CHECKS.filter(c=>r.checks.filter(i=>i.checkClass===c).length!==1);
 const uncertain=missingCheckClasses.length>0||r.checks.some(c=>c.result==='UNCERTAIN'||c.confidence!=='HIGH'||c.result==='PASS'&&c.issues.length>0||c.result==='DEFECT'&&c.issues.length===0);
 const issues=r.checks.filter(c=>c.result==='DEFECT').flatMap(c=>c.issues),regenerate=issues.some(i=>!i.localRepairable)||issues.filter(i=>i.severity==='MAJOR').length>1;
 const result=uncertain?'UNCERTAIN':issues.length?(regenerate?'REGENERATE':'REPAIRABLE'):'PASS';
 return {report:mapMinimalInspection({result,confidence:uncertain?'LOW':'HIGH',issues},brief,'BACK'),missingCheckClasses};
}
export function minimalEscalationBrief(context:any,fast:any,target:'SIDE'|'BACK'){
 const f=fast[target],coarsePass=(f.coarseStatus??f.status)==='PASS'&&f.confidence==='HIGH';
 const coarsePassedFacts=coarsePass?['SINGLE_SUBJECT','TARGET_VIEW','NO_OBVIOUS_CONTAMINATION','COARSE_IDENTITY_CONSISTENCY']:[];
 const requestedCheckClasses=context.integrityProfile==='HUMAN'?['HAND_ANATOMY_ORIENTATION','FOOT_TOE_HEEL_ORIENTATION',target==='BACK'?'REAR_LIMB_JOINT_COHERENCE':'LIMB_JOINT_COHERENCE']:f.unverifiedFor?.length?f.unverifiedFor:['FINE_ATTACHMENT_TOPOLOGY'];
 return {version:MINIMAL_ESCALATION_VERSION,assetProfile:context.integrityProfile,...(context.integrityProfile==='HUMAN'&&target==='BACK'?{fineDetailVersion:FINE_DETAIL_VERSION}:{MAIN:'identity reference'}),target,confirmedPreserveFacts:context.mustPreserve??[],coarsePassedFacts,requestedCheckClasses};
}
export function mapMinimalInspection(input:unknown,brief:any,target:'SIDE'|'BACK'){
 const r=minimalResponse.parse(input),certain=r.confidence==='HIGH'&&r.result!=='UNCERTAIN',coarse=new Set(brief.coarsePassedFacts??[]);
 return {confidence:r.confidence,...inspection.parse({reviewed:certain,identity:coarse.has('COARSE_IDENTITY_CONSISTENCY')?'PASS':'UNKNOWN',view:coarse.has('TARGET_VIEW')?'PASS':'UNKNOWN',contamination:coarse.has('SINGLE_SUBJECT')&&coarse.has('NO_OBVIOUS_CONTAMINATION')?'PASS':'UNKNOWN',issues:r.issues.map(i=>({id:randomUUID(),category:'PART_ATTACHMENT',affectedRegion:i.region,description:i.problem,severity:i.severity,confidence:r.confidence,localizable:i.localRepairable,repairability:!certain?'HUMAN_REVIEW':r.result==='REGENERATE'||!i.localRepairable?'REGENERATE_VIEW':'LOCAL_REPAIR',evidenceViews:[target]}))})};
}
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function inspectIntegrityVision(projectId:number,brief:any,images:{view:string;bytes:Buffer;mimeType:string}[],options?:{prepared:Awaited<ReturnType<typeof prepareIntegrityVision>>;transportMode:'NATIVE'|'JSON_TEXT';targetView:'SIDE'|'BACK'|'ALL'}){
 const started=Date.now(),correlationId=randomUUID();let model='UNCONFIGURED';const target=options?.targetView??'ALL',requestedCheckClasses=target==='ALL'?[...new Set(Object.values(brief.targets??{}).flatMap((b:any)=>b.requestedCheckClasses??[]))]:brief.requestedCheckClasses??[];let imageViewsSent:string[]=[];let fineAudit:any={};
 try{const prepared=options?.prepared??await prepareIntegrityVision(projectId);model=prepared.model;const session=prepared.session;const fine=isHumanBack(brief,target),back=images.find(i=>i.view==='BACK');if(fine&&!back)throw Error('VISION_EVIDENCE_INVALID');const detail=fine?await humanBackDerivatives(back!):null;fineAudit=detail?.audit??{};const selected=detail?.images??await inspectionDerivatives(target==='ALL'?images:images.filter(i=>i.view==='MAIN'||i.view===target));imageViewsSent=selected.map(i=>i.view);if(!fine&&target!=='ALL'&&(imageViewsSent.length!==2||!imageViewsSent.includes('MAIN')||!imageViewsSent.includes(target)))throw Error('VISION_EVIDENCE_INVALID');const resultSchema=fine?fineResponse:target==='ALL'?z.object({SIDE:minimalResponse,BACK:minimalResponse}).strict():minimalResponse;
  const content:any[]=[{type:'text',text:JSON.stringify(fine?{...brief,detailRegions:fineAudit.detailCrops.map((c:any)=>({region:c.region,check:c.check,normalizedBounds:c.normalizedBounds})),detailLayout:'top-left: left/right arms; top-right: feet/heels; bottom-left: rear legs/joints; bottom-right: lower body context'}:brief)}];for(const image of selected){content.push({type:'text',text:`Image view: ${image.view}`},{type:'image',image:image.bytes,mediaType:image.mimeType});}
  const request={schema:resultSchema,maxRetries:0,abortSignal:AbortSignal.timeout(visionTimeouts.inspection),system:'MAIN is the identity reference. Inspect only unresolved fine structure in each requested target independently. Use confirmed preserve facts; fictional anatomy overrides priors; not visible is not missing. Do not re-evaluate coarse facts, style, lighting or mood. Do not perform cross-view analysis. Return result, confidence, issues for each requested target. Do not invent defects; use UNCERTAIN when unsure.',messages:[{role:'user' as const,content}]};
  if(target!=='ALL')request.system='MAIN is the identity reference. Inspect '+target+' only. Use confirmed preserve facts; fictional anatomy overrides priors; not visible is not missing. Coarse facts listed in the brief already passed. Do not re-evaluate style, lighting, mood, subject count, general viewpoint or other views. Inspect only requested fine structure. Return PASS only if these regions are structurally plausible; if uncertain return UNCERTAIN. Do not invent defects. Return result, confidence, issues (region, problem, severity, localRepairable). No repair execution.';
  if(fine)request.system='Inspect BACK for every requested fine structural check independently. BACK_FULL provides whole-body context; BACK_DETAIL enlarges crops from the same original. Do not judge style, mood, lighting or aesthetics, identity or subject count. Fixed crops may miss a region; insufficient or occluded detail means UNCERTAIN, not PASS. Do not invent defects. Return checks: checkClass, result (PASS/DEFECT/UNCERTAIN), confidence (HIGH/MEDIUM/LOW), issues (region, problem, severity, localRepairable).';
  const response=options?.transportMode==='JSON_TEXT'?await session.invoke({...request,system:request.system+' Reply with exactly one JSON object, no markdown.'}):await session.invokeObject(request);
  const parsed:any=resultSchema.parse(options?.transportMode==='JSON_TEXT'?strictVisionJson((response as any).text):(response as any).object),fineResult=fine?mapFineInspection(parsed,brief):null,reports:Record<string,ReturnType<typeof mapMinimalInspection>>=fineResult?{BACK:fineResult.report}:target!=='ALL'?{[target]:mapMinimalInspection(parsed,brief,target)}:Object.fromEntries((['SIDE','BACK'] as const).map(view=>[view,mapMinimalInspection(parsed[view],brief.targets[view],view)]));
  for(const [view,r] of Object.entries(reports))for(const issue of r.issues)if(view==='CROSS_VIEW'?(issue.category!=='CROSS_VIEW'||new Set(issue.evidenceViews).size<2):!issue.evidenceViews.includes(view as 'SIDE'|'BACK'))throw Error('VISION_EVIDENCE_INVALID');
  const usage:any=response.usage;
  return {status:'SUCCEEDED',reports,audit:{version:VISION_INTEGRITY_VERSION,configSignature:prepared.signature,derivatives:selected.map(i=>i.audit),...fineAudit,...(fineResult?{missingCheckClasses:fineResult.missingCheckClasses,checkResults:parsed.checks}:{}),targetView:target,requestedCheckClasses,imageViewsSent,transportMode:options?.transportMode??'NATIVE',correlationId,modelRole:'vision',providerId:model.split(':')[0].replace(/[^\w.-]/g,'').slice(0,80),modelName:model.split(':').slice(1).join(':').replace(/[^\w.\/-]/g,'').slice(0,120),briefHash:hash(brief),responseHash:hash(parsed),latencyMs:Date.now()-started,usage:usage?Object.fromEntries(['inputTokens','outputTokens','totalTokens'].filter(k=>Number.isFinite(usage[k])).map(k=>[k,usage[k]])):null,cost:null}};
 }catch(error:any){const code=visionError(error,'inspection');console.error('[V04 Integrity]',{correlationId,errorCode:code,errorName:String(error?.name??'Error').replace(/[^\w.-]/g,'').slice(0,80)});
  return {status:'FAILED',reports:null,audit:{version:VISION_INTEGRITY_VERSION,correlationId,errorCode:code,...fineAudit,targetView:target,requestedCheckClasses,imageViewsSent,transportMode:options?.transportMode??'NATIVE',briefHash:hash(brief),responseHash:null,latencyMs:Date.now()-started,modelRole:'vision',providerId:model.split(':')[0].replace(/[^\w.-]/g,'').slice(0,80),modelName:model.split(':').slice(1).join(':').replace(/[^\w.\/-]/g,'').slice(0,120),usage:null,cost:null}};
 }
}

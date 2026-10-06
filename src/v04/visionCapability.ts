import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {z} from 'zod';
export const VISION_TRANSPORT_VERSION='integrity.vision-transport.1';
export const visionTimeouts={single:30000,multi:45000,inspection:60000};
export type InspectionImage={view:string;bytes:Buffer;mimeType:string};
export const imageProbe=z.object({subjectCount:z.number().int().min(0).max(20),confidence:z.enum(['HIGH','MEDIUM','LOW'])}).strict();
export const multiProbe=z.object({sameSubject:z.boolean(),obviousStructuralAnomaly:z.boolean(),uncertain:z.boolean()}).strict();
export function strictVisionJson(text:string){return JSON.parse(text.trim());}
export async function inspectionDerivatives(images:InspectionImage[]){
 return Promise.all(images.map(async image=>{const bytes=await sharp(image.bytes,{limitInputPixels:16000000}).rotate().resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).flatten({background:'#ededed'}).jpeg({quality:85}).toBuffer();const m=await sharp(bytes).metadata();return {view:image.view,bytes,mimeType:'image/jpeg',audit:{view:image.view,sha256:createHash('sha256').update(bytes).digest('hex'),width:m.width,height:m.height,byteLength:bytes.length,version:VISION_TRANSPORT_VERSION}};}));
}
export function visionError(error:any,stage:'single'|'structured'|'multi'|'inspection'){
 const chain:any[]=[];let e=error;for(let i=0;e&&i<5;i++,e=e.cause)chain.push(e);
 const text=chain.map(e=>`${e.name??''} ${e.message??''} ${e.functionality??''}`).join(' ');
 const timeout=/Timeout|Abort/i.test(text),unsupported=/unsupported|not supported|does not support|not allowed/i.test(text);
 if(timeout)return stage==='single'||stage==='structured'?'VISION_SINGLE_IMAGE_TIMEOUT':stage==='multi'?'VISION_MULTI_IMAGE_TIMEOUT':'VISION_PROVIDER_TIMEOUT';
 if(unsupported&&/image|vision|multimodal/i.test(text))return stage==='multi'?'VISION_MULTI_IMAGE_UNSUPPORTED':'VISION_IMAGE_INPUT_UNSUPPORTED';
 if(unsupported&&/schema|structured|response.?format|json.?schema/i.test(text))return 'VISION_STRUCTURED_OUTPUT_UNSUPPORTED';
 if(/Zod|NoObjectGenerated|JSONParse|TypeValidation|SyntaxError/.test(text))return 'VISION_SCHEMA_FAILED';
 return 'VISION_PROVIDER_FAILED';
}
const messages=(question:string,images:InspectionImage[])=>[{role:'user' as const,content:[{type:'text' as const,text:question},...images.flatMap(i=>[{type:'text' as const,text:`Image ${i.view}`},{type:'image' as const,image:i.bytes,mediaType:i.mimeType}])]}];
export async function probeVisionCapability(session:any,images:InspectionImage[],mode:'NATIVE'|'JSON_TEXT'='NATIVE'){
 const report:any={version:'integrity.vision-capability.1',state:'UNAVAILABLE',imageInput:'NOT_RUN',structuredOutput:'NOT_RUN',multiImage:'NOT_RUN',recommendedMode:'UNSUPPORTED',transportMode:mode,testedAt:Date.now(),stages:[],apiCallCount:0};
 for(const stage of ['single','structured','multi'] as const){const started=Date.now();try{
  const shape=stage==='multi'?multiProbe:imageProbe,question=stage==='single'?'How many primary people are visible? Reply with only one integer between 0 and 20.':stage==='structured'?'Return only JSON: {"subjectCount":number,"confidence":"HIGH"|"MEDIUM"|"LOW"}. Count visible primary people.':'Return only JSON: {"sameSubject":boolean,"obviousStructuralAnomaly":boolean,"uncertain":boolean}. Compare the supplied views conservatively.';
  const opts={maxRetries:0,abortSignal:AbortSignal.timeout(stage==='multi'?visionTimeouts.multi:visionTimeouts.single),maxOutputTokens:300,system:'VISION_CAPABILITY_PREFLIGHT. Answer the small image question only. No repair or asset mutation.',messages:messages(question,stage==='multi'?images:images.slice(0,1))};report.apiCallCount++;
  if(stage==='single'){const r=await session.invoke(opts);if(!/^\s*(?:[0-9]|1[0-9]|20)\s*$/.test(r.text??''))throw new SyntaxError('count response invalid');}
  else{const r=mode==='NATIVE'?await session.invokeObject({...opts,schema:shape}):await session.invoke(opts);shape.parse(mode==='NATIVE'?r.object:strictVisionJson(r.text));}
  report[stage==='single'?'imageInput':stage==='structured'?'structuredOutput':'multiImage']='PASS';report.stages.push({stage,status:'PASS',latencyMs:Date.now()-started});
 }catch(error){const code=visionError(error,stage),status=code.includes('TIMEOUT')?'TIMEOUT':'FAIL';report[stage==='single'?'imageInput':stage==='structured'?'structuredOutput':'multiImage']=status;report.stages.push({stage,status,errorCode:code,latencyMs:Date.now()-started});report.errorCode=code;break;}}
 if(report.imageInput==='PASS'&&report.structuredOutput==='PASS'&&report.multiImage==='PASS'){report.state='INTEGRITY_VISION_READY';report.recommendedMode='MULTI_STRUCTURED';}
 report.latencyMs=report.stages.reduce((sum:number,s:any)=>sum+s.latencyMs,0);return report;
}

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import getPath from '@/utils/getPath';
import {acquireDraftWorkerLease} from './draftWorkerLease';
import {inspection} from './assetIntegrity';
import {requiredVisualChecks,FastVisionInspectorAdapter} from './fastIntegrityGate';
import {inspectionDerivatives,InspectionImage} from './visionCapability';
const verdict=z.enum(['PASS','FAIL','UNKNOWN']);
const result=z.object({checks:z.object(Object.fromEntries(requiredVisualChecks.map(k=>[k,verdict.optional()]))).strict(),confidence:z.enum(['HIGH','MEDIUM','LOW']),localizedDefects:z.array(z.object({check:z.enum(['PART_STRUCTURE','ATTACHMENT']),region:z.string().min(1).max(80),description:z.string().min(1).max(300)}).strict()).max(3).default([])}).strict();
export const LOCAL_INSPECTOR_VERSION='integrity.local-cpu.1';
export function localInspectorConfiguration(){
 const fields=['PYTHON','RUNTIME','MODEL','MMPROJ','PROBE'] as const,config=Object.fromEntries(fields.map(f=>[f,process.env['DS_V04_FAST_VISION_'+f]??'']));
 try{if(fields.some(f=>!config[f]||!fs.existsSync(config[f])))return null;const probe=JSON.parse(fs.readFileSync(config.PROBE,'utf8'));
 if(probe.status!=='SUCCEEDED'||String(probe.reply).trim()!=='1'||probe.modelPath!==config.MODEL||probe.mmprojPath!==config.MMPROJ||probe.modelSize!==fs.statSync(config.MODEL).size||probe.mmprojSize!==fs.statSync(config.MMPROJ).size)return null;
 return config;}catch{return null;}
}
export function invokeLocalInspector(config:Record<string,string>,question:string,images:{view:string;bytes:Buffer}[],maxTokens=512):Promise<any>{
 return new Promise((resolve,reject)=>{const child=spawn(config.PYTHON,[path.resolve('pilot/localIntegrityInspector.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let text='',settled=false;
 const done=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};const timer=setTimeout(()=>done(Error('LOCAL_INSPECTOR_TIMEOUT')),45000);
 child.stdout.on('data',b=>{text+=b.toString();if(text.length>100000)done(Error('LOCAL_INSPECTOR_OUTPUT_LIMIT'));});child.stderr.on('data',()=>{});child.on('error',()=>done(Error('LOCAL_INSPECTOR_UNAVAILABLE')));child.stdin.on('error',()=>done(Error('LOCAL_INSPECTOR_INPUT_FAILED')));child.on('close',code=>{try{const lines=text.split(/\r?\n/).filter(l=>l.startsWith('QA_RESULT:'));if(code!==0||lines.length!==1)throw Error('LOCAL_INSPECTOR_FAILED');const value=JSON.parse(lines[0].slice(10));if(value.status!=='SUCCEEDED')throw Error('LOCAL_INSPECTOR_'+String(value.errorName??'FAILED').replace(/[^A-Za-z]/g,''));done(undefined,value);}catch(error:any){done(Error(error.message?.startsWith('LOCAL_INSPECTOR_')?error.message:'LOCAL_INSPECTOR_FAILED'));}});
 child.stdin.end(JSON.stringify({runtimePath:config.RUNTIME,modelPath:config.MODEL,mmprojPath:config.MMPROJ,question,images:images.map(i=>({view:i.view,base64:i.bytes.toString('base64')})),maxTokens,jsonMode:maxTokens>32}));
 });
}
export function createLocalFastVisionAdapter(images:InspectionImage[]):FastVisionInspectorAdapter{
 const config=localInspectorConfiguration();if(!config)return {state:'UNAVAILABLE',inspect:async()=>{throw Error('LOCAL_VISION_NOT_PROVEN');}};
 return {state:'AVAILABLE',capabilityClass:'COARSE_ONLY',inspect:async(brief:any)=>{const release=await acquireDraftWorkerLease(getPath(['v04-draft-worker.lock']));if(!release)throw Error('LOCAL_VISION_GPU_BUSY');try{
 const view=brief.view,derivatives=await inspectionDerivatives(images.filter(i=>i.view==='MAIN'||i.view===view));
 const question='Inspect TARGET '+view+' only; MAIN is reference, not a second subject in the target. FAST obvious visual QA, not deep diagnosis. Not visible is not missing; confirmed fictional appendages are valid. Return JSON {"checks":{"SUBJECT_COUNT":"PASS|FAIL|UNKNOWN","VIEW":"PASS|FAIL|UNKNOWN","PART_STRUCTURE":"PASS|FAIL|UNKNOWN","ATTACHMENT":"PASS|FAIL|UNKNOWN","CONTAMINATION":"PASS|FAIL|UNKNOWN","CROSS_VIEW":"PASS|FAIL|UNKNOWN"},"confidence":"HIGH|MEDIUM|LOW","localizedDefects":[]}. SUBJECT_COUNT: one target subject? VIEW: broadly '+view+'? PART_STRUCTURE: no obvious duplicated/missing/grossly malformed major parts? ATTACHMENT: no detached/floating parts? CONTAMINATION: no extra person/animal/text? CROSS_VIEW: no major identity/footwear/design contradiction to MAIN? Use UNKNOWN when uncertain. Only obvious localized defects may add {check:PART_STRUCTURE or ATTACHMENT,region,description}; otherwise empty list. Context:'+JSON.stringify(brief);
 const output=await invokeLocalInspector(config,question,derivatives),normalized=compileLocalObservation(parseLocalOutput(output.text),view);
 return {...normalized,audit:{version:LOCAL_INSPECTOR_VERSION,device:'CPU',loadMs:output.loadMs,inferenceMs:output.inferenceMs,derivatives:derivatives.map(i=>i.audit)}};
 }finally{await release();}}};
}

export function compileLocalObservation(input:unknown,view:string){const parsed:any=result.parse(normalizeLocalFormat(input)),checks=requiredVisualChecks.filter(k=>parsed.checks[k]&&parsed.checks[k]!=='UNKNOWN'),issues:any[]=[];
 for(const defect of parsed.localizedDefects)if(parsed.checks[defect.check]!=='FAIL')throw Error('LOCAL_INSPECTOR_CONTRADICTORY_RESULT');
 for(const check of ['PART_STRUCTURE','ATTACHMENT'])if(parsed.checks[check]==='FAIL'){const localized=parsed.localizedDefects.find((d:any)=>d.check===check);issues.push({id:randomUUID(),category:'PART_ATTACHMENT',affectedRegion:localized?.region??null,description:localized?.description??'Local inspector reports an obvious major structural defect',severity:localized?'MODERATE':'MAJOR',confidence:parsed.confidence,localizable:!!localized,repairability:localized?'LOCAL_REPAIR':'REGENERATE_VIEW',evidenceViews:[view]});}
 const report=inspection.parse({reviewed:checks.length===requiredVisualChecks.length,identity:parsed.checks.CROSS_VIEW??'UNKNOWN',view:parsed.checks.VIEW??'UNKNOWN',contamination:parsed.checks.SUBJECT_COUNT==='FAIL'?'FAIL':parsed.checks.CONTAMINATION??'UNKNOWN',issues});
 return {checks,confidence:parsed.confidence,report};}

function parseLocalOutput(text:string){try{return JSON.parse(text.trim());}catch{throw Error('LOCAL_INSPECTOR_JSON_INVALID');}}

// Normalize casing only. Unknown fields/verdicts remain subject to strict validation.
function normalizeLocalFormat(input:unknown){if(!input||typeof input!=='object'||Array.isArray(input))return input;
 const aliases:Record<string,string>={checks:'checks',confidence:'confidence',localizeddefects:'localizedDefects'};
 const out:Record<string,any>={};for(const [key,value]of Object.entries(input)){const target=aliases[key.toLowerCase()]??key;if(target in out)throw Error('LOCAL_INSPECTOR_DUPLICATE_FIELD');out[target]=value;}
 if(typeof out.confidence==='string')out.confidence=out.confidence.trim().toUpperCase();
 if(out.checks&&typeof out.checks==='object'&&!Array.isArray(out.checks)){const checks:Record<string,unknown>={};for(const [key,value]of Object.entries(out.checks)){const target=key.toUpperCase();if(target in checks)throw Error('LOCAL_INSPECTOR_DUPLICATE_FIELD');checks[target]=typeof value==='string'?value.trim().toUpperCase():value;}out.checks=checks;}
 return out;
}

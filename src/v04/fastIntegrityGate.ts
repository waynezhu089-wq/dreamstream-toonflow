import {inspection,repairDecision} from './assetIntegrity';
export const FAST_GATE_VERSION='integrity.fast-gate.1';
export const requiredVisualChecks=['SUBJECT_COUNT','VIEW','PART_STRUCTURE','ATTACHMENT','CONTAMINATION','CROSS_VIEW'] as const;
export type FastVisionInspectorAdapter={state:'AVAILABLE'|'UNAVAILABLE';inspect:(brief:unknown)=>Promise<{checks:string[];confidence:'LOW'|'MEDIUM'|'HIGH';report:unknown;audit?:unknown}>};
export const unavailableFastVision:FastVisionInspectorAdapter={state:'UNAVAILABLE',inspect:async()=>{throw Error('LOCAL_VISION_UNAVAILABLE');}};
export async function fastIntegrityGate(metadata:{name:string;pass:boolean}[],brief:unknown,adapter:FastVisionInspectorAdapter=unavailableFastVision){
 const started=Date.now(),base={version:FAST_GATE_VERSION,checks:metadata,localVisionState:adapter.state,requiredVisualChecks,latencyMs:0};
 if(metadata.some(c=>!c.pass))return {...base,status:'CLEAR_GLOBAL_DEFECT',confidence:'HIGH',escalationRequired:false,evidence:['deterministic metadata failure'],latencyMs:Date.now()-started,report:null};
 if(adapter.state==='UNAVAILABLE')return {...base,status:'SUSPECT',confidence:'LOW',escalationRequired:true,evidence:['metadata valid; required visual checks unresolved'],latencyMs:Date.now()-started,report:null};
 try{const v=await adapter.inspect(brief);Object.assign(base,{localAudit:v.audit??null});const report=inspection.parse(v.report);
  if(v.confidence!=='HIGH'||requiredVisualChecks.some(key=>!v.checks.includes(key))||!report.reviewed||[report.identity,report.view,report.contamination].includes('UNKNOWN')||report.issues.some(i=>i.confidence!=='HIGH'))return {...base,status:'SUSPECT',confidence:v.confidence,escalationRequired:true,evidence:['visual coverage or confidence insufficient'],latencyMs:Date.now()-started,report};
  const decision=repairDecision(report),status=decision==='PASS'?'PASS':decision==='REPAIRABLE'?'CLEAR_LOCAL_DEFECT':decision==='REGENERATE'?'CLEAR_GLOBAL_DEFECT':'SUSPECT';
  return {...base,status,confidence:v.confidence,escalationRequired:status==='SUSPECT',evidence:['bounded local visual observation'],latencyMs:Date.now()-started,report};
 }catch(error:any){return {...base,errorCode:/^LOCAL_[A-Za-z_]+$/.test(error?.message??'')?error.message:'LOCAL_INSPECTOR_FAILED',status:'UNAVAILABLE',localVisionState:'FAILED',confidence:'LOW',escalationRequired:true,evidence:['local inspector technical failure'],latencyMs:Date.now()-started,report:null};}
}

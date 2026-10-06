import {repairDecision} from './assetIntegrity';
export const DECISION_ENGINE_VERSION='integrity.decision-engine.1';
export function integrityDecision(fast:any,vision?:{confidence:string;report:any}|null){
 if(fast.status==='CLEAR_GLOBAL_DEFECT')return {result:'REGENERATE',decisionAuthority:fast.localVisionState==='AVAILABLE'?'FAST_VISION':'FAST_DETERMINISTIC'};
 if(fast.status==='PASS'||fast.status==='CLEAR_LOCAL_DEFECT')return {result:fast.status==='PASS'?'PASS':'REPAIRABLE',decisionAuthority:'FAST_VISION'};
 if(vision&&vision.confidence==='HIGH')return {result:repairDecision(vision.report),decisionAuthority:'VISION_API'};
 return {result:'HUMAN_REVIEW',decisionAuthority:vision?'VISION_API':'HUMAN'};
}
export const retryPolicy={version:'integrity.retry-budget.1',maxLocalRepairs:1,maxWholeViewRegenerations:1,automaticExecutionEnabled:false};

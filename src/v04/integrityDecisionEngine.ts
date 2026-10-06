import {repairDecision} from './assetIntegrity';
export const DECISION_ENGINE_VERSION='integrity.decision-engine.2';
export type FastCapabilityClass='COARSE_ONLY'|'FINE_STRUCTURE_VALIDATED';
export function requiredCheckPolicy(profile:string,view:string){
 const fine=profile==='HUMAN'?(view==='BACK'?'FINE_EXTREMITY_STRUCTURE':'FINE_LIMB_COHERENCE'):profile==='VEHICLE'?'FINE_STRUCTURAL_CONNECTION':profile==='PROP'?'FINE_CONNECTOR_GEOMETRY':'FINE_ATTACHMENT_TOPOLOGY';
 return ['COARSE',fine];
}
export function fastAuthority(fast:any,profile:string,view:string,humanDecision?:string){
 const requiredCheckClasses=requiredCheckPolicy(profile,view),capabilityClass:FastCapabilityClass=fast.capabilityClass??'COARSE_ONLY',coarseStatus=fast.coarseStatus??fast.status;
 const unverifiedFor=capabilityClass==='FINE_STRUCTURE_VALIDATED'?[]:requiredCheckClasses.filter(c=>c!=='COARSE');
 const conflict=coarseStatus==='PASS'&&['REPAIRABLE','REGENERATE'].includes(humanDecision??'');
 return {...fast,capabilityClass,coarseStatus,requiredCheckClasses,authoritativeFor:capabilityClass==='FINE_STRUCTURE_VALIDATED'?requiredCheckClasses:['COARSE'],unverifiedFor,humanConflict:conflict?'FAST_HUMAN_CONFLICT':null,humanDecision:humanDecision??null,status:coarseStatus==='PASS'&&(conflict||unverifiedFor.length)?'SUSPECT_FINE_DETAIL':fast.status,escalationRequired:!!fast.escalationRequired||conflict||coarseStatus==='PASS'&&unverifiedFor.length>0};
}
export function integrityDecision(fast:any,vision?:{confidence:string;report:any}|null){
 if(vision&&vision.confidence==='HIGH')return {result:repairDecision(vision.report),decisionAuthority:'VISION_API'};
 if(fast.humanConflict||fast.status==='SUSPECT_FINE_DETAIL'||fast.status==='PASS'&&(fast.capabilityClass!=='FINE_STRUCTURE_VALIDATED'||fast.unverifiedFor?.length))return {result:'HUMAN_REVIEW',decisionAuthority:'HUMAN'};
 if(fast.status==='CLEAR_GLOBAL_DEFECT')return {result:'REGENERATE',decisionAuthority:fast.localVisionState==='AVAILABLE'?'FAST_VISION':'FAST_DETERMINISTIC'};
 if(fast.status==='PASS'||fast.status==='CLEAR_LOCAL_DEFECT')return {result:fast.status==='PASS'?'PASS':'REPAIRABLE',decisionAuthority:'FAST_VISION'};
 return {result:'HUMAN_REVIEW',decisionAuthority:vision?'VISION_API':'HUMAN'};
}
export const retryPolicy={version:'integrity.retry-budget.1',maxLocalRepairs:1,maxWholeViewRegenerations:1,automaticExecutionEnabled:false};

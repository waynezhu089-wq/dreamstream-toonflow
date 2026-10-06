import type {FastVisionInspectorAdapter} from './fastIntegrityGate';
import {inspection} from './assetIntegrity';
export const ASSET_PIPELINE_QA_V1='asset.pipeline-coarse-qa.1';
export const knownFailureClasses=['SUBJECT_COUNT','CONTAMINATION','VIEW','PART_STRUCTURE','ATTACHMENT','CROSS_VIEW'] as const;
// Coarse observations never claim hand/foot anatomy or production acceptance.
export async function inspectAssetCandidate(metadata:{width:number;height:number},brief:any,adapter:FastVisionInspectorAdapter){
 const base={version:ASSET_PIPELINE_QA_V1,requestedChecks:knownFailureClasses,authority:'COARSE_CANDIDATE_ONLY',humanReviewRequired:true};
 if(metadata.width<64||metadata.height<64)return {...base,status:'CLEAR_FAILURE',reason:'OUTPUT_DIMENSIONS_INVALID'};
 if(adapter.state!=='AVAILABLE')return {...base,status:'ATTENTION',reason:'LOCAL_INSPECTOR_UNAVAILABLE'};
 try{const v=await adapter.inspect(brief),report=inspection.parse(v.report);
   const failed=[report.identity,report.view,report.contamination].includes('FAIL')||report.issues.some(i=>i.confidence==='HIGH'&&i.severity==='MAJOR');
   if(v.confidence==='HIGH'&&failed)return {...base,status:'CLEAR_FAILURE',reason:'COARSE_VISUAL_FAILURE',observation:v};
   const required=brief.view==='MAIN'?['SUBJECT_COUNT','CONTAMINATION','PART_STRUCTURE','ATTACHMENT']:knownFailureClasses;
   const proven=v.confidence==='HIGH'&&required.every(k=>v.checks.includes(k))&&!failed&&report.issues.length===0;
   return {...base,status:proven?'PASS_COARSE':'ATTENTION',reason:proven?'COARSE_CHECKS_COMPLETED':'CHECKS_UNRESOLVED',observation:v};
 }catch{return {...base,status:'ATTENTION',reason:'LOCAL_INSPECTOR_FAILED'};}
}

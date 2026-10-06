import {z} from 'zod';
import {resolveIntegrityProfile} from './integrityProfileResolver';
export const dimensions=['PART_COUNT','PART_ATTACHMENT','ORIENTATION','TOPOLOGY','SUPPORT','SYMMETRY','PERSPECTIVE','MATERIAL','FUNCTION','CONTAMINATION','CROSS_VIEW'] as const;
const profile=(regions:string[],focus:string[])=>({regions,focus});
export const integrityProfiles={
 HUMAN:profile(['手','脚','四肢','服装','头部'],['joint direction','footwear','clothing-body relationship']),
 ANIMAL:profile(['肢体','爪/蹄/鳍','尾巴','耳朵','眼睛'],['confirmed limb count','attachment']),
 FANTASY_CREATURE:profile(['肢体','翅膀','角','尾巴'],['confirmed fictional morphology overrides ordinary priors']),
 VEHICLE:profile(['车轮','船体/车身','门','后部','桅杆'],['functional attachment','bow/stern','axle orientation']),
 PROP:profile(['把手','开口','连接','支撑'],['functional geometry']),
 FURNITURE:profile(['腿/支撑','座面','靠背','抽屉'],['weight support']),
 MACHINE:profile(['部件','外壳','接口','铰链'],['component connection']),
 ARCHITECTURE:profile(['楼层','楼梯','门窗','柱子'],['support','scale','entry/exit']),
 GENERIC_STRUCTURED_ASSET:profile(['结构','连接','数量','方向','材质'],['attachment','orientation','perspective'])
};
export function integrityProfile(kind:string){return resolveIntegrityProfile({assetKind:kind}).profile;}
export const integrityIssue=z.object({id:z.string().uuid(),category:z.enum(dimensions),affectedRegion:z.string().min(1).max(100).nullable(),description:z.string().min(1).max(1000),severity:z.enum(['MINOR','MODERATE','MAJOR']),confidence:z.enum(['LOW','MEDIUM','HIGH']),localizable:z.boolean(),repairability:z.enum(['LOCAL_REPAIR','REGION_REPAIR','REGENERATE_VIEW','HUMAN_REVIEW']),evidenceViews:z.array(z.enum(['MAIN','SIDE','BACK'])).min(1).max(3)}).strict();
export const inspection=z.object({reviewed:z.boolean(),identity:z.enum(['PASS','FAIL','UNKNOWN']),view:z.enum(['PASS','FAIL','UNKNOWN']),contamination:z.enum(['PASS','FAIL','UNKNOWN']),issues:z.array(integrityIssue).max(30)}).strict();
export function repairDecision(input:z.infer<typeof inspection>){
 if(!input.reviewed||[input.identity,input.view,input.contamination].includes('UNKNOWN'))return 'HUMAN_REVIEW';
 if(input.identity==='FAIL'||input.view==='FAIL'||input.contamination==='FAIL')return 'REGENERATE';
 if(input.issues.some(i=>i.confidence==='LOW'||i.repairability==='HUMAN_REVIEW'))return 'HUMAN_REVIEW';
 if(input.issues.some(i=>i.repairability==='REGENERATE_VIEW'||!i.localizable||i.category==='TOPOLOGY')||input.issues.filter(i=>i.severity==='MAJOR').length>1)return 'REGENERATE';
 return input.issues.length?'REPAIRABLE':'PASS';
}
// Observations are human evidence. Occluded visible counts never prove missing parts.
export function compareStructuralCounts(confirmed:Record<string,number>,observations:{part:string;visibleCount:number;occluded:boolean;knownCount?:number}[]){return observations.filter(o=>confirmed[o.part]!==undefined&&(o.visibleCount>confirmed[o.part]||(o.knownCount!==undefined&&o.knownCount!==confirmed[o.part])||(!o.occluded&&o.visibleCount<confirmed[o.part])));}
export function integrityFresh(a:any,b:any){return JSON.stringify(a)===JSON.stringify(b);}
export function makeRepairProposals(reports:Record<string,z.infer<typeof inspection>>,input:any,identityLock:any){return Object.entries(reports).flatMap(([view,r])=>r.issues.map(i=>({sourceArtifact:view==='CROSS_VIEW'?input.artifacts:input.artifacts[view],issueIds:[i.id],targetRegions:i.affectedRegion?[i.affectedRegion]:[],repairMode:repairDecision(r)==='HUMAN_REVIEW'?'HUMAN_ONLY':repairDecision(r)==='REGENERATE'?'VIEW_REGENERATE':i.repairability==='LOCAL_REPAIR'?'LOCAL_INPAINT':i.repairability==='REGION_REPAIR'?'REGION_INPAINT':i.repairability==='REGENERATE_VIEW'?'VIEW_REGENERATE':'HUMAN_ONLY',preserveOutsideRegion:true,identityLock,repairInstruction:`仅处理已记录的问题：${i.description}；保留身份、视角及未受影响区域。`,executionAuthorized:false})));}

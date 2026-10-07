import {createHash} from 'node:crypto';
export const CANONICAL_PACKAGE_VERSION='asset.krea-draft-klein-package.1';
export const PACKAGE_PROMPT_COMPILER_VERSION='asset.five-layer.1';
export const packageHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function compileAssetGenerationContext(asset:any,spec:any,creative:any,director:any,assetIntentPatch=''){
 const intent=director?.intent;
 const role=intent?.narrativeVisualRoles?.find((r:any)=>r.canonicalKey===asset.canonicalKey)??null;
 // Execution outputs/references are not Creative truth. Do not hash attachment
 // adoption, presentation timestamps, or automatically inherited Director IDs.
 const scriptContext={brief:creative?.brief??'',treatment:creative?.treatment??'',script:creative?.script??'',targetDuration:creative?.targetDuration??null,aspectRatio:creative?.aspectRatio??null};
 const assetSpec={canonicalKey:asset.canonicalKey,revision:asset.revision,category:asset.category,assetKind:asset.assetKind,sourcePolicy:asset.sourcePolicy,description:asset.description,identityAnchors:asset.identityAnchors,mustPreserve:asset.mustPreserve,forbiddenChanges:asset.forbiddenChanges,ownerKey:asset.ownerKey,variantOf:asset.variantOf,sharedVisualSystemKey:asset.sharedVisualSystemKey,relatedKeys:asset.relatedKeys,visualSpec:spec};
 const stable={directorSemanticHash:packageHash(intent??null),scriptContextHash:packageHash(scriptContext),assetSpecHash:packageHash(assetSpec),assetIntentPatch,pipelineVersion:CANONICAL_PACKAGE_VERSION,promptCompilerVersion:PACKAGE_PROMPT_COMPILER_VERSION};
 return {...stable,upstreamHash:packageHash(stable),directorVersionId:director?.current?.id??null,directorVisualSummary:JSON.stringify(intent?.globalVisualDNA??{}).slice(0,3000),scriptContextSummary:JSON.stringify(scriptContext).slice(0,5000),assetRoleSummary:JSON.stringify(role??{assetKind:asset.assetKind,description:asset.description}).slice(0,2000)};
}
export function packageStage(job:any){try{return JSON.parse(job.inputSnapshotJson).packageStage??null;}catch{return null;}}

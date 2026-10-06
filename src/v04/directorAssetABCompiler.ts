import {compileAssetRenderingBrief,renderAssetRenderingBrief} from './assetRenderingBrief';
import {PilotError} from './service';
import { createHash } from 'node:crypto';
import type { DirectorIntent } from './directorContract';
import { autoAssetPrompt } from './autoAssetPrompt';
import { directorCanonical } from './directorCompiler';
import {projectGlobalVisualDNAForAsset} from './directorAssetVisualDNA';
import {compileDirectorRenderingBrief,renderKreaDirectorBrief} from './directorRenderingBrief';
export const abHash = (x:unknown) => createHash('sha256').update(directorCanonical(x)).digest('hex');
export const DIRECTOR_AB_COMPILER='director.asset-ab.2';
export function compileDirectorABAssetInput(asset:any,spec:any,creative:any,intent:DirectorIntent,directorVersion:number,legacyCompilation:unknown=null) {
  const key=asset.canonicalKey;
  const directorContext={generationMode:'ASSET',canonicalKey:key,directorVersion,
    narrativeRole:intent.narrativeVisualRoles.find(r=>r.canonicalKey===key)??null,
    relevantScaleRelations:intent.scaleRelations.filter(r=>r.kind!=='SHOT_SPECIFIC'&&(r.smaller===key||r.larger===key)),
    relevantTransformationLineage:intent.transformationLineage.filter(r=>r.from===key||r.to===key)};
  const assetVisualDNA=projectGlobalVisualDNAForAsset({asset,visualSpec:spec,narrativeRole:directorContext.narrativeRole,globalVisualDNA:intent.globalVisualDNA,
    relevantLineage:directorContext.relevantTransformationLineage,relevantScale:directorContext.relevantScaleRelations});
  const context={...directorContext,assetVisualDNA};
  const semanticInput={asset,spec,creative,legacyCompilation};
  const renderedPrompt=autoAssetPrompt(asset,spec,creative,'ASSET_MAIN_PREVIEW');
  const renderingBrief=compileDirectorRenderingBrief(asset,spec,context);
  const augmentation=renderKreaDirectorBrief(renderingBrief);
  const A={semanticInput,renderedPrompt,inputHash:abHash({semanticInput,renderedPrompt})};
  const B={semanticInput,directorContext:context,renderingBrief,renderedPrompt:augmentation,inputHash:abHash({semanticInput,directorContext:context,renderingBrief,renderedPrompt:augmentation})};
  return {A,B};
}

export const DIRECTOR_CONTROLLED_EXPERIMENT_VERSION='director.asset-control.1';
export function compileDirectorControlledAssetInput(asset:any,spec:any,creative:any,intent:DirectorIntent,directorVersion:number,legacyCompilation:unknown=null){
 const legacy=compileDirectorABAssetInput(asset,spec,creative,intent,directorVersion,legacyCompilation);
 const {brief,omitted}=compileAssetRenderingBrief(asset,spec),cleanBasePrompt=renderAssetRenderingBrief(brief),cleanBaseHash=abHash({brief,cleanBasePrompt});
 // Delta scale must come from Director evidence only, never from spec scale/proportion.
 const directorRenderingBrief=compileDirectorRenderingBrief(asset,{...spec,scale:'',proportion:''},legacy.B.directorContext);
 const candidates=[directorRenderingBrief.scalePresence,directorRenderingBrief.visualCharacter,directorRenderingBrief.lighting,directorRenderingBrief.environmentStyle].flat();
 let words=0;const delta=[...new Set(candidates)].filter(p=>{if(cleanBasePrompt.includes(p))return false;const n=p.split(/\s+/).length;if(words+n>100)return false;words+=n;return true;});
 const directorDeltaPrompt=delta.length?delta.join('. ')+'.':'',directorDeltaHash=abHash({version:directorRenderingBrief.version,directorDeltaPrompt});
 const renderedPrompt=cleanBasePrompt+(directorDeltaPrompt?'\nDirector visual direction: '+directorDeltaPrompt:'');
 if(renderedPrompt.split(/\s+/).length>250)throw new PilotError('DIRECTOR_AB_NOT_READY','三组实验输入超过长度上限',409);
 const base={semanticInput:legacy.A.semanticInput,assetRenderingBrief:brief,cleanBasePrompt,cleanBaseHash,assetCompilationAudit:{omitted}};
 return {comparisonDesign:'LEGACY_VS_CLEAN_VS_DIRECTOR',compilerVersion:DIRECTOR_CONTROLLED_EXPERIMENT_VERSION,
 A0:legacy.A,A1:{...base,renderedPrompt:cleanBasePrompt,inputHash:cleanBaseHash},B:{...base,directorContext:legacy.B.directorContext,directorRenderingBrief,directorDeltaPrompt,directorDeltaHash,renderedPrompt,inputHash:abHash({cleanBaseHash,directorDeltaHash,renderedPrompt})}};
}

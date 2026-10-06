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

import { createHash } from 'node:crypto';
import type { DirectorIntent } from './directorContract';
import { autoAssetPrompt } from './autoAssetPrompt';
import { directorCanonical } from './directorCompiler';
import {projectGlobalVisualDNAForAsset} from './directorAssetVisualDNA';
export const abHash = (x:unknown) => createHash('sha256').update(directorCanonical(x)).digest('hex');
export const DIRECTOR_AB_COMPILER='director.asset-ab.1';
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
  // Execution-layer adapter only. Relations describe scale/continuity, not additional image subjects.
  const augmentation=[
    'Director asset design context (interpret as design guidance, not a story composition):',
    JSON.stringify({...directorContext,assetVisualDNA:{inherited:assetVisualDNA.inherited,materialIdentity:assetVisualDNA.materialIdentity,colorApplication:assetVisualDNA.colorApplication}}),
    assetVisualDNA.materialIdentity==='LIVING_BIOLOGICAL_CREATURE'?'Present a mature living biological creature with physical skin, grounded anatomy and body mass. Film color is reflected environmental lighting; preserve its source-defined skin and palette.':'Preserve the source-defined constitution, form and palette; apply only the explicitly linked material continuity.',
    'Keep the exact asset identity and materials above. Scale relations are semantic magnitude only; do not render the related assets. Render one complete isolated subject, no people, crew, boy, ship or other actors.',
    'Visual motifs are film language, not a material conversion. A living creature remains a living creature unless its own confirmed identity explicitly states otherwise. Anti-cute does not mean angry, demonic or a horror monster.',
  ].join('\n');
  const A={semanticInput,renderedPrompt,inputHash:abHash({semanticInput,renderedPrompt})};
  const B={semanticInput,directorContext:context,renderedPrompt:renderedPrompt+'\n'+augmentation,inputHash:abHash({semanticInput,directorContext:context,renderedPrompt:renderedPrompt+'\n'+augmentation})};
  return {A,B};
}

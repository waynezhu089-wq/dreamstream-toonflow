export const KREA2_ASSET_T2I_RENDERING_V1 = 'krea2.asset-t2i.rendering.1';
export const AUTO_ASSET_RECONCILER_V1 = 'auto.asset.reconciler.1';
export function autoAssetPriority(asset: any) {
  const order = ['HUMAN_CHARACTER','CREATURE','VEHICLE','PROP','ENVIRONMENT','MATERIAL_FX','CELESTIAL'];
  return (asset.importance === 'CORE' ? 0 : 10) + Math.max(0, order.indexOf(asset.assetKind));
}
export function autoAssetRoles(asset: any): string[] {
  if (asset.importance !== 'CORE' || asset.sourcePolicy !== 'AI_ALLOWED') return [];
  return ({HUMAN_CHARACTER:['FACE_HERO','FULL_BODY_FRONT','FULL_BODY_BACK'],
    CREATURE:['HERO_3Q','SIDE_PROFILE','BACK_3Q'], VEHICLE:['HERO_3Q','SIDE_PROFILE','REAR_3Q','DETAIL_REFERENCE'],
    PROP:['HERO_3Q','SIDE_PROFILE','DETAIL_REFERENCE']} as Record<string,string[]>)[asset.assetKind] ?? [];
}
export function autoAssetComposition(kind: string) {
  return ({HUMAN_CHARACTER:'One character, full body head to feet visible, natural proportions, neutral character-design presentation, no unrelated objects.',
    CREATURE:'One complete creature ONLY, readable silhouette, all wings and limbs visible. No human, rider, passenger or other creature. Isolated asset, not a story scene.',
    VEHICLE:'One complete vehicle ONLY in three-quarter hero view, readable structure, materials and proportions. Unoccupied: no human, crew, passenger or rider. Isolated asset, not a story scene.',
    PROP:'One complete object ONLY in a clean hero concept view, readable shape and materials. No people or hands holding it.',
    ENVIRONMENT:'Cinematic wide establishing view. No unplanned characters or animals.',
    MATERIAL_FX:'Material study with readable texture, emission, state and manifestation behavior; no unrelated characters.',
    CELESTIAL:'Clear celestial form and composition with readable surface and lighting.'} as Record<string,string>)[kind] ?? 'Clear single-subject concept presentation.';
}
export function autoAssetResolution(kind: string) {
  return ['HUMAN_CHARACTER','CREATURE'].includes(kind) ? {width:768,height:1024} :
    kind === 'ENVIRONMENT' ? {width:1152,height:640} : kind === 'VEHICLE' ? {width:1024,height:768} : {width:832,height:832};
}
export function autoAssetPrompt(asset: any, spec: any, creative: any, role = 'ASSET_MAIN_PREVIEW') {
  const view = ({FACE_HERO:'Chest-up portrait, clearly readable face.',FULL_BODY_FRONT:'Complete body, directly facing camera.',
    FULL_BODY_BACK:'Complete body, directly facing away from camera.',HERO_3Q:'Complete subject, three-quarter hero view.',
    SIDE_PROFILE:'Complete subject, exact side profile.',BACK_3Q:'Complete subject, rear three-quarter view.',
    REAR_3Q:'Complete subject, rear three-quarter view.',DETAIL_REFERENCE:'Close view of distinctive structural details.'} as Record<string,string>)[role];
  return [asset.name, spec.visualIdentitySummary, asset.description,
    `Identity: ${JSON.stringify(spec.identityAnchors)}. Preserve: ${JSON.stringify(spec.mustPreserve)}.`,
    `Appearance: ${JSON.stringify({silhouette:spec.silhouette,scale:spec.scale,proportion:spec.proportion,
      palette:spec.primaryPalette,materials:spec.materials,details:spec.details})}.`,
    role === 'ASSET_MAIN_PREVIEW' ? autoAssetComposition(asset.assetKind) :
      `Derive from the supplied identity reference, do not redesign identity, costume, footwear, palette or proportions. Change only camera/body orientation. ${view}`,
    'Cinematic stylized realism, refined concept art, soft filmic lighting, coherent material detail; no chibi proportions, no text or multi-view sheet.',
    `Avoid: ${JSON.stringify(spec.forbiddenChanges)}.`,
    `Project direction (context only, do not insert other story subjects): ${(creative?.brief ?? '').slice(0,1200)}`].join('\n');
}

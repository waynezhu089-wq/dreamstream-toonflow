export const KLEIN_MULTIVIEW_FROM_MAIN_V1 = 'klein.multiview-from-main.1';
export function assetViewPlan(asset: any): string[] {
  if (asset.sourcePolicy !== 'AI_ALLOWED') return [];
  if (asset.assetKind === 'HUMAN_CHARACTER') return ['SIDE_PROFILE','FULL_BODY_BACK'];
  if (asset.assetKind === 'CREATURE') return ['SIDE_PROFILE','BACK_3Q'];
  if (asset.assetKind === 'VEHICLE') return /船|ship/i.test(asset.name)
    ? ['SIDE_PROFILE','FULL_BODY_FRONT'] : ['SIDE_PROFILE','FULL_BODY_FRONT','REAR_3Q'];
  if (asset.assetKind === 'PROP') return ['SIDE_PROFILE'];
  return [];
}

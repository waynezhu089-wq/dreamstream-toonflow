export const assetKinds = ["HUMAN_CHARACTER", "CREATURE", "VEHICLE", "PROP", "ENVIRONMENT", "MATERIAL_FX", "CELESTIAL", "BRAND_MARK", "UI_REFERENCE", "OTHER"] as const;
export type AssetKind = typeof assetKinds[number];

export function reviewPlanFor(asset: { category: string; assetKind: AssetKind; importance: "CORE" | "SUPPORTING"; sourcePolicy: string }) {
  if (asset.category === "BRAND" || asset.category === "UI" || asset.assetKind === "BRAND_MARK" || asset.assetKind === "UI_REFERENCE" || asset.sourcePolicy === "REAL_REQUIRED")
    return { previewKind: "REFERENCE_ONLY", previewStatus: "REFERENCE_REQUIRED", turnaroundStatus: "NOT_APPLICABLE",
      previewSpec: JSON.stringify({ mode: "REFERENCE_BINDING", reviewOnly: true, aiRedrawAllowed: false }), turnaroundSpec: "{}" };
  const previewKind = asset.assetKind === "ENVIRONMENT" || asset.assetKind === "CELESTIAL" ? "ESTABLISHING" :
    asset.assetKind === "MATERIAL_FX" ? "MATERIAL_BOARD" :
    asset.assetKind === "HUMAN_CHARACTER" || asset.assetKind === "CREATURE" ? "CHARACTER" : "OBJECT";
  const turnable = ["HUMAN_CHARACTER", "CREATURE", "VEHICLE", "PROP"].includes(asset.assetKind);
  return { previewKind, previewStatus: "PLANNED", turnaroundStatus: turnable ? asset.importance === "CORE" ? "PLANNED" : "OPTIONAL" : "NOT_APPLICABLE",
    previewSpec: JSON.stringify({ mode: previewKind, maxEdge: 512, reviewOnly: true, producer: "LOCAL_IMAGE_CAPABILITY_PENDING" }),
    turnaroundSpec: turnable ? JSON.stringify({ views: ["FRONT", "SIDE", "BACK"], maxEdge: 512, reviewOnly: true, producer: "LOCAL_IMAGE_CAPABILITY_PENDING" }) : "{}" };
}

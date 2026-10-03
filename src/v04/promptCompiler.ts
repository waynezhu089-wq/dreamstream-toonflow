import type { VisualSpec } from "./visualSpecContract";

export const PROMPT_COMPILER_VERSION = "v04.prompt-ir.1";
const CHARACTER_TURNAROUND_COMPILER_VERSION = "v04.prompt-ir.2";
export const generationIntents = ["CHARACTER_TURNAROUND", "CREATURE_TURNAROUND", "VEHICLE_TURNAROUND", "OBJECT_REFERENCE", "ENVIRONMENT_ESTABLISHING", "MATERIAL_STATE_BOARD", "CELESTIAL_REFERENCE"] as const;
export type GenerationIntent = typeof generationIntents[number];

export function compilerVersionForIntent(intent: GenerationIntent): string {
  return intent === "CHARACTER_TURNAROUND" ? CHARACTER_TURNAROUND_COMPILER_VERSION : PROMPT_COMPILER_VERSION;
}

const characterIdentityLock = ["same character identity", "same face", "same hairstyle", "same clothing",
  "same footwear", "same body proportions", "same color palette"];
const characterForbiddenChanges = ["no redesign between views", "no clothing changes", "no hairstyle changes",
  "no age changes", "no body proportion changes", "no extra accessories"];
const characterAllowedVariation = ["camera orientation", "body orientation"];

export function intentFromReviewPlan(asset: { sourcePolicy: string; assetKind: string }, plan: { previewKind: string }): GenerationIntent | null {
  if (asset.sourcePolicy === "REAL_REQUIRED" || plan.previewKind === "REFERENCE_ONLY") return null;
  switch (asset.assetKind) {
    case "HUMAN_CHARACTER": return "CHARACTER_TURNAROUND";
    case "CREATURE": return "CREATURE_TURNAROUND";
    case "VEHICLE": return "VEHICLE_TURNAROUND";
    case "PROP": case "OTHER": return "OBJECT_REFERENCE";
    case "ENVIRONMENT": return "ENVIRONMENT_ESTABLISHING";
    case "MATERIAL_FX": return "MATERIAL_STATE_BOARD";
    case "CELESTIAL": return "CELESTIAL_REFERENCE";
    default: return null;
  }
}

// Only this asset's own confirmed identity/spec is compiled. Owner and child
// keys are identifiers, never recursive prompt expansion.
export function compilePromptIR(asset: { canonicalKey: string; name: string; description: string; ownerKey?: string | null; variantOf?: string | null; sharedVisualSystemKey?: string | null }, spec: VisualSpec, generationIntent: GenerationIntent, referenceBindings: { attachmentId: string; name: string }[] = []) {
  if (spec.assetKind === "BRAND_MARK" || spec.assetKind === "UI_REFERENCE") throw new Error("REFERENCE_ONLY_NO_AI_PROMPT");
  const details = spec.details as Record<string, unknown>;
  const views = generationIntent.endsWith("TURNAROUND") ? ["FRONT", "LEFT_PROFILE", "BACK", "THREE_QUARTER"] : [];
  const empty = spec.assetKind === "ENVIRONMENT" && details.emptyEnvironmentPolicy === "EMPTY_CANONICAL_REFERENCE";
  const states = spec.assetKind === "MATERIAL_FX" ? details.states : [];
  return {
    schemaVersion: 1, compilerVersion: compilerVersionForIntent(generationIntent), generationIntent,
    identityBlock: { canonicalKey: asset.canonicalKey, name: asset.name, description: asset.description,
      visualIdentitySummary: spec.visualIdentitySummary, identityAnchors: spec.identityAnchors,
      ownerKey: asset.ownerKey ?? null, variantOf: asset.variantOf ?? null,
      sharedVisualSystemKey: asset.sharedVisualSystemKey ?? null },
    appearanceBlock: { silhouette: spec.silhouette, scale: spec.scale, proportion: spec.proportion,
      distinctiveFeatures: spec.distinctiveFeatures, details },
    materialBlock: { materials: spec.materials, surfaceLanguage: spec.surfaceLanguage,
      primaryPalette: spec.primaryPalette, secondaryPalette: spec.secondaryPalette },
    continuityBlock: { mustPreserve: spec.mustPreserve, continuityNotes: spec.continuityNotes,
      embeddedElements: spec.embeddedElements.map(element => ({ id: element.embeddedElementId, name: element.name,
        visualDescription: element.visualDescription, placement: element.placement })) },
    environmentBlock: spec.assetKind === "ENVIRONMENT" ? { ...details, emptyCanonicalReference: empty } : null,
    viewIntent: views.map(orientation => ({ orientation, identityInvariant: asset.canonicalKey })),
    ...(generationIntent === "CHARACTER_TURNAROUND" ? { characterTurnaround: {
      identityLock: characterIdentityLock, forbiddenChanges: characterForbiddenChanges,
      allowedVariation: characterAllowedVariation } } : {}),
    compositionIntent: generationIntent === "MATERIAL_STATE_BOARD" ? { states,
      sharedPalette: spec.primaryPalette, sharedMaterialLogic: spec.surfaceLanguage } : { emptyEnvironment: empty },
    positiveConstraints: [...spec.identityAnchors, ...spec.mustPreserve],
    negativeConstraints: [...spec.forbiddenChanges, ...(empty ? ["No unplanned people, animals, logos or buildings"] : [])],
    referenceBindings: referenceBindings.map(ref => ({ attachmentId: ref.attachmentId, name: ref.name,
      provenance: "CONFIRMED_ASSET_BIBLE_REFERENCE" })),
  };
}

export function renderGenericPrompt(ir: ReturnType<typeof compilePromptIR>) {
  const detailLines: string[] = [];
  function appendDetails(value: unknown, label: string) {
    if (typeof value === "string") { if (value.trim()) detailLines.push(`${label}: ${value}`); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => appendDetails(item, `${label}.${index + 1}`)); return; }
    if (value && typeof value === "object") for (const [field, child] of Object.entries(value)) appendDetails(child, label ? `${label}.${field}` : field);
  }
  appendDetails(ir.appearanceBlock.details, "appearance");
  const base = [ir.identityBlock.name, ir.identityBlock.visualIdentitySummary,
    ir.appearanceBlock.silhouette, ir.materialBlock.surfaceLanguage,
    ...ir.materialBlock.primaryPalette, ...detailLines, ...ir.positiveConstraints].filter(Boolean).join("; ");
  const turnaround = "characterTurnaround" in ir ? ir.characterTurnaround : null;
  const lock = turnaround ? `Shared Identity Lock across all views: ${turnaround.identityLock.join(", ")}` : "";
  const variation = turnaround ? `Only ${turnaround.allowedVariation.join(" and ")} may vary between views` : "";
  const exclusions = turnaround ? `Forbidden: ${turnaround.forbiddenChanges.join(", ")}` : "";
  const text = turnaround
    ? `${base}; Create a four-view character turnaround: ${ir.viewIntent.map(view => view.orientation).join(", ")}; ${lock}; ${variation}; ${exclusions}`
    : base;
  const negative = [...ir.negativeConstraints, ...(turnaround?.forbiddenChanges ?? [])].join("; ");
  return { adapter: "generic.text.v1", text, negative,
    views: ir.viewIntent.map(view => ({ orientation: view.orientation, text: turnaround
      ? `${base}; ${view.orientation} view; ${lock}; ${variation}; ${exclusions}`
      : `${base}; ${view.orientation} view; same identity and details across views` })),
    stateSlots: ir.generationIntent === "MATERIAL_STATE_BOARD" ? ir.compositionIntent.states : [],
    note: "Derived review text only; no image execution" };
}

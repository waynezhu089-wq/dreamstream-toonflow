import { z } from "zod";
import type { AssetKind } from "./assetWorkflow";

const line = z.string().max(600);
const lines = z.array(line).max(30);
const embeddedElement = z.object({
  embeddedElementId: z.string().min(1).max(80), name: line, visualDescription: line,
  placement: line, continuityImportance: z.enum(["LOW", "MEDIUM", "HIGH"]),
  promotionRecommendation: z.enum(["LOW", "MEDIUM", "HIGH"]),
  suggestedCategory: z.string().max(40).nullable(), suggestedAssetKind: z.string().max(60).nullable(),
}).strict();

const common = {
  visualIdentitySummary: line, silhouette: line, scale: line, proportion: line,
  primaryPalette: lines, secondaryPalette: lines, materials: lines, surfaceLanguage: line,
  distinctiveFeatures: lines, continuityNotes: lines, identityAnchors: lines,
  mustPreserve: lines, forbiddenChanges: lines, embeddedElements: z.array(embeddedElement).max(30),
};
const human = z.object({ ageRange: line, genderPresentation: line,
  face: z.object({ faceShape: line, facialFeatures: line, skinTone: line, eyeLanguage: line }).strict(),
  hair: z.object({ color: line, length: line, silhouette: line, styling: line }).strict(),
  body: z.object({ build: line, heightProportion: line, ageProportion: line }).strict(),
  wardrobe: z.object({ upper: line, lower: line, outer: line, material: line, palette: line }).strict(),
  footwear: line, defaultExpression: line, expressionRange: lines }).strict();
const creature = z.object({ speciesOrForm: line, bodyStructure: line, anatomy: line, relativeScale: line,
  surface: line, skinFurFeatherLanguage: line, eyes: line, movementLanguage: line }).strict();
const vehicle = z.object({ vehicleType: line, overallSilhouette: line, relativeScale: line,
  mainStructure: line, secondaryStructure: line, surfaceTreatment: line, propulsion: line,
  windows: line, openings: line }).strict();
const environment = z.object({ spaceType: line, geography: line, layout: line, scale: line,
  foreground: line, midground: line, background: line, architectureOrNaturalForms: lines,
  timeOfDay: line, weather: line, atmosphere: line, lighting: line, recurringAnchors: lines,
  emptyEnvironmentPolicy: z.enum(["EMPTY_CANONICAL_REFERENCE", "SUBJECTS_ALLOWED"]) }).strict();
const materialFx = z.object({ baseColor: line, emissionColor: line, particleLanguage: line,
  edgeLanguage: line, density: line, transparency: line,
  states: z.array(z.object({ key: z.enum(["MIST", "PARTICLE", "SILHOUETTE", "SOLID"]), appearance: line }).strict()).length(4),
  transitionRules: lines, interactionRules: lines, manifestationRules: lines }).strict();
const celestial = z.object({ form: line, phase: line, surfaceOrGlow: line, halo: line,
  relativeScale: line, palette: lines, compositionRole: line }).strict();
const reference = z.object({ referenceDerived: z.literal(true), aiRedrawAllowed: z.literal(false),
  referenceAttachmentIds: z.array(z.string()).min(1).max(30), referenceConstraints: lines,
  observedReferenceNotes: z.array(z.object({ attachmentId: z.string(), summary: line,
    uncertainty: lines }).strict()).max(30) }).strict();
const object = z.object({ objectType: line, structure: line, use: line }).strict();

export const visualSpecSchema = z.discriminatedUnion("assetKind", [
  z.object({ assetKind: z.literal("HUMAN_CHARACTER"), ...common, details: human }).strict(),
  z.object({ assetKind: z.literal("CREATURE"), ...common, details: creature }).strict(),
  z.object({ assetKind: z.literal("VEHICLE"), ...common, details: vehicle }).strict(),
  z.object({ assetKind: z.literal("PROP"), ...common, details: object }).strict(),
  z.object({ assetKind: z.literal("ENVIRONMENT"), ...common, details: environment }).strict(),
  z.object({ assetKind: z.literal("MATERIAL_FX"), ...common, details: materialFx }).strict(),
  z.object({ assetKind: z.literal("CELESTIAL"), ...common, details: celestial }).strict(),
  z.object({ assetKind: z.literal("BRAND_MARK"), ...common, details: reference }).strict(),
  z.object({ assetKind: z.literal("UI_REFERENCE"), ...common, details: reference }).strict(),
  z.object({ assetKind: z.literal("OTHER"), ...common, details: object }).strict(),
]);
export type VisualSpec = z.infer<typeof visualSpecSchema>;

// The provider supplies visual meaning, never database identity or canonical enums.
export const visualSemanticDto = z.object({
  visualIdentitySummary: line.optional(), silhouette: line.optional(), scale: line.optional(), proportion: line.optional(),
  primaryPalette: lines.optional(), secondaryPalette: lines.optional(), materials: lines.optional(),
  surfaceLanguage: line.optional(), distinctiveFeatures: lines.optional(), continuityNotes: lines.optional(),
  identityAnchors: lines.optional(), mustPreserve: lines.optional(), forbiddenChanges: lines.optional(),
  embeddedElements: z.array(z.object({ name: line, visualDescription: line.optional(), placement: line.optional(),
    continuityImportance: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(), promotionRecommendation: z.enum(["LOW", "MEDIUM", "HIGH"]).optional() }).passthrough()).max(30).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function fillShape(example: unknown, incoming: unknown): unknown {
  if (Array.isArray(example)) return Array.isArray(incoming) ? incoming : example;
  if (example && typeof example === "object") {
    const source = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(example).map(([key, value]) => [key, fillShape(value, source[key])]));
  }
  return typeof incoming === typeof example ? incoming : example;
}

const detailDefaults: Record<AssetKind, unknown> = {
  HUMAN_CHARACTER: { ageRange: "", genderPresentation: "", face: { faceShape: "", facialFeatures: "", skinTone: "", eyeLanguage: "" }, hair: { color: "", length: "", silhouette: "", styling: "" }, body: { build: "", heightProportion: "", ageProportion: "" }, wardrobe: { upper: "", lower: "", outer: "", material: "", palette: "" }, footwear: "", defaultExpression: "", expressionRange: [] },
  CREATURE: { speciesOrForm: "", bodyStructure: "", anatomy: "", relativeScale: "", surface: "", skinFurFeatherLanguage: "", eyes: "", movementLanguage: "" },
  VEHICLE: { vehicleType: "", overallSilhouette: "", relativeScale: "", mainStructure: "", secondaryStructure: "", surfaceTreatment: "", propulsion: "", windows: "", openings: "" },
  PROP: { objectType: "", structure: "", use: "" },
  ENVIRONMENT: { spaceType: "", geography: "", layout: "", scale: "", foreground: "", midground: "", background: "", architectureOrNaturalForms: [], timeOfDay: "", weather: "", atmosphere: "", lighting: "", recurringAnchors: [], emptyEnvironmentPolicy: "EMPTY_CANONICAL_REFERENCE" },
  MATERIAL_FX: { baseColor: "", emissionColor: "", particleLanguage: "", edgeLanguage: "", density: "", transparency: "", states: [{ key: "MIST", appearance: "" }, { key: "PARTICLE", appearance: "" }, { key: "SILHOUETTE", appearance: "" }, { key: "SOLID", appearance: "" }], transitionRules: [], interactionRules: [], manifestationRules: [] },
  CELESTIAL: { form: "", phase: "", surfaceOrGlow: "", halo: "", relativeScale: "", palette: [], compositionRole: "" },
  BRAND_MARK: { referenceDerived: true, aiRedrawAllowed: false, referenceAttachmentIds: [], referenceConstraints: [], observedReferenceNotes: [] },
  UI_REFERENCE: { referenceDerived: true, aiRedrawAllowed: false, referenceAttachmentIds: [], referenceConstraints: [], observedReferenceNotes: [] },
  OTHER: { objectType: "", structure: "", use: "" },
};

export function visualDetailTemplate(kind: AssetKind): unknown {
  return JSON.parse(JSON.stringify(detailDefaults[kind]));
}

export function compileVisualSemantic(asset: { assetKind: AssetKind; name: string; description: string; identityAnchors: string[]; mustPreserve: string[]; forbiddenChanges: string[] }, raw: unknown, confirmedReferenceIds: string[] = [], observedReferenceNotes: { attachmentId: string; summary: string; uncertainty: string[] }[] = []): VisualSpec {
  const semantic = visualSemanticDto.parse(raw);
  const referenceOnly = asset.assetKind === "BRAND_MARK" || asset.assetKind === "UI_REFERENCE";
  const details = referenceOnly ? { referenceDerived: true, aiRedrawAllowed: false,
    referenceAttachmentIds: confirmedReferenceIds, referenceConstraints: [...asset.mustPreserve, ...asset.forbiddenChanges], observedReferenceNotes }
    : fillShape(detailDefaults[asset.assetKind], semantic.details);
  const elements = (semantic.embeddedElements ?? []).map((element, index) => ({
    embeddedElementId: `embedded-${index + 1}`, name: element.name, visualDescription: element.visualDescription ?? "",
    placement: element.placement ?? "", continuityImportance: element.continuityImportance ?? "LOW",
    promotionRecommendation: element.promotionRecommendation ?? "LOW", suggestedCategory: null, suggestedAssetKind: null,
  }));
  return visualSpecSchema.parse({ assetKind: asset.assetKind,
    visualIdentitySummary: semantic.visualIdentitySummary || asset.description || asset.name,
    silhouette: semantic.silhouette ?? "", scale: semantic.scale ?? "", proportion: semantic.proportion ?? "",
    primaryPalette: semantic.primaryPalette ?? [], secondaryPalette: semantic.secondaryPalette ?? [],
    materials: semantic.materials ?? [], surfaceLanguage: semantic.surfaceLanguage ?? "",
    distinctiveFeatures: semantic.distinctiveFeatures ?? [], continuityNotes: semantic.continuityNotes ?? [],
    identityAnchors: semantic.identityAnchors ?? asset.identityAnchors,
    mustPreserve: semantic.mustPreserve ?? asset.mustPreserve,
    forbiddenChanges: semantic.forbiddenChanges ?? asset.forbiddenChanges,
    embeddedElements: elements, details,
  });
}

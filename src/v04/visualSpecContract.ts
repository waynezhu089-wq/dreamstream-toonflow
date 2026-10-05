import { z } from "zod";
import type { AssetKind } from "./assetWorkflow";
import { normalizeVisualSemantic, visualDetailTemplates, visualQualityWarnings, type VisualWarning } from "./visualSemanticNormalizer";

import { referencePlanSchema, resolveCharacterReferencePlan } from "./characterReferencePack";

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
  z.object({ assetKind: z.literal("HUMAN_CHARACTER"), ...common, details: human, referencePlan: referencePlanSchema.optional() }).strict(),
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

export function visualDetailTemplate(kind: AssetKind): unknown {
  return JSON.parse(JSON.stringify(visualDetailTemplates[kind]));
}

export function compileVisualSemanticWithDiagnostics(asset: { assetKind: AssetKind; name: string; description: string; identityAnchors: string[]; mustPreserve: string[]; forbiddenChanges: string[] }, raw: unknown, confirmedReferenceIds: string[] = [], observedReferenceNotes: { attachmentId: string; summary: string; uncertainty: string[] }[] = []): { spec: VisualSpec; normalizationWarnings: VisualWarning[]; qualityWarnings: VisualWarning[] } {
  const referenceOnly = asset.assetKind === "BRAND_MARK" || asset.assetKind === "UI_REFERENCE";
  const normalized = referenceOnly ? null : normalizeVisualSemantic(raw, asset);
  const common = normalized?.common ?? { visualIdentitySummary: asset.description.slice(0, 600) || asset.name.slice(0, 600),
    silhouette: "", scale: "", proportion: "", primaryPalette: [], secondaryPalette: [], materials: [], surfaceLanguage: "",
    distinctiveFeatures: [], continuityNotes: [], identityAnchors: asset.identityAnchors, mustPreserve: asset.mustPreserve,
    forbiddenChanges: asset.forbiddenChanges, embeddedElements: [] };
  const details = referenceOnly ? { referenceDerived: true, aiRedrawAllowed: false,
    referenceAttachmentIds: confirmedReferenceIds, referenceConstraints: [...asset.mustPreserve, ...asset.forbiddenChanges], observedReferenceNotes }
    : normalized!.details;
  const spec = visualSpecSchema.parse({ assetKind: asset.assetKind, ...common, details, ...(asset.assetKind === "HUMAN_CHARACTER" ? { referencePlan: resolveCharacterReferencePlan({}) } : {}) });
  return { spec, normalizationWarnings: normalized?.warnings ?? [], qualityWarnings: visualQualityWarnings(spec) };
}

export function compileVisualSemantic(asset: { assetKind: AssetKind; name: string; description: string; identityAnchors: string[]; mustPreserve: string[]; forbiddenChanges: string[] }, raw: unknown, confirmedReferenceIds: string[] = [], observedReferenceNotes: { attachmentId: string; summary: string; uncertainty: string[] }[] = []): VisualSpec {
  return compileVisualSemanticWithDiagnostics(asset, raw, confirmedReferenceIds, observedReferenceNotes).spec;
}

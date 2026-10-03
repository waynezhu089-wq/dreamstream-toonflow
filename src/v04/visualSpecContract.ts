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

const materialStateOrder = ["MIST", "PARTICLE", "SILHOUETTE", "SOLID"] as const;
type MaterialState = typeof materialStateOrder[number];
const materialStateAliases: Record<string, MaterialState> = {
  MIST: "MIST", FOG: "MIST", VAPOR: "MIST", VAPOUR: "MIST", 雾: "MIST", 雾态: "MIST",
  PARTICLE: "PARTICLE", PARTICLES: "PARTICLE", CONDENSATION: "PARTICLE", 颗粒: "PARTICLE", 粒子: "PARTICLE", 凝聚: "PARTICLE",
  SILHOUETTE: "SILHOUETTE", CONTOUR: "SILHOUETTE", OUTLINE: "SILHOUETTE", EMERGING_FORM: "SILHOUETTE", 轮廓: "SILHOUETTE", 成形轮廓: "SILHOUETTE",
  SOLID: "SOLID", SOLID_FORM: "SOLID", MANIFESTED: "SOLID", ENTITY: "SOLID", FINAL_FORM: "SOLID", 实体: "SOLID", 实体态: "SOLID",
};

function materialStateKey(value: unknown): MaterialState | null {
  if (typeof value !== "string") return null;
  return materialStateAliases[value.trim().toUpperCase().replace(/[\s-]+/g, "_")] ?? null;
}

function materialStateFromAppearance(appearance: string): MaterialState | null {
  const cues: [MaterialState, RegExp][] = [
    ["MIST", /\b(mist|fog|vapor|vapour)\b|雾/iu],
    ["PARTICLE", /\b(particles?|grains?|condensation)\b|颗粒|粒子|凝聚/iu],
    ["SILHOUETTE", /\b(silhouette|contour|outline)\b|轮廓/iu],
    ["SOLID", /\b(solid|manifested|entity|final form)\b|实体/iu],
  ];
  const matched = cues.filter(([, pattern]) => pattern.test(appearance));
  return matched.length === 1 ? matched[0][0] : null;
}

function compileMaterialFxDetails(asset: { name: string; description: string }, semantic: z.infer<typeof visualSemanticDto>) {
  const incoming = semantic.details ?? {};
  const details = fillShape(detailDefaults.MATERIAL_FX, incoming) as Record<string, unknown>;
  const rawStates = incoming.states;
  const states = Array.isArray(rawStates) ? rawStates : rawStates && typeof rawStates === "object"
    ? Object.entries(rawStates).map(([key, value]) => typeof value === "string" ? { key, appearance: value } : { key, ...(value && typeof value === "object" ? value : {}) })
    : [];
  const keyed = new Map<MaterialState, string>();
  const unkeyed: string[] = [];
  for (const raw of states) {
    const row: Record<string, unknown> = raw && typeof raw === "object" ? raw as Record<string, unknown> : { appearance: raw };
    const appearance = [row.appearance, row.description].find(value => typeof value === "string" && value.trim()) as string | undefined;
    if (!appearance) continue;
    const label = row.key ?? row.name ?? row.state ?? row.phase ?? row.label;
    const key = materialStateKey(label);
    if (key && !keyed.has(key)) keyed.set(key, appearance);
    else if (label == null) {
      const inferred = materialStateFromAppearance(appearance);
      if (inferred && !keyed.has(inferred)) keyed.set(inferred, appearance);
      else if (!inferred) unkeyed.push(appearance);
    }
  }
  const identity = [asset.name, asset.description, semantic.visualIdentitySummary].filter(value => typeof value === "string" && value.trim()).join(" — ").slice(0, 320);
  const color = [details.baseColor, details.emissionColor, ...(semantic.primaryPalette ?? [])].filter(value => typeof value === "string" && value.trim()).join(", ").slice(0, 120);
  const cues = `${identity}${color ? `; color and glow: ${color}` : ""}`;
  const fallback: Record<MaterialState, string> = {
    MIST: `Diffuse mist phase of ${cues}`,
    PARTICLE: `Condensed particle phase of ${cues}; ${details.particleLanguage || "visible particles"}`,
    SILHOUETTE: `Particles gather into a recognizable silhouette of ${cues}; ${details.edgeLanguage || "continuous contour"}`,
    SOLID: `Coherent solid manifestation of ${cues}`,
  };
  details.states = materialStateOrder.map(key => ({ key, appearance: keyed.get(key) ?? unkeyed.shift() ?? fallback[key].slice(0, 600) }));
  const rules: Record<string, string> = {
    transitionRules: "Preserve one material identity and palette through MIST → PARTICLE → SILHOUETTE → SOLID.",
    interactionRules: "Interactions preserve the same material identity and confirmed visual cues.",
    manifestationRules: "Manifestation follows MIST → PARTICLE → SILHOUETTE → SOLID without introducing a new identity.",
  };
  for (const [field, rule] of Object.entries(rules)) if (Array.isArray(details[field]) && details[field].length === 0) details[field] = [rule];
  return details;
}

export function visualDetailTemplate(kind: AssetKind): unknown {
  return JSON.parse(JSON.stringify(detailDefaults[kind]));
}

export function compileVisualSemantic(asset: { assetKind: AssetKind; name: string; description: string; identityAnchors: string[]; mustPreserve: string[]; forbiddenChanges: string[] }, raw: unknown, confirmedReferenceIds: string[] = [], observedReferenceNotes: { attachmentId: string; summary: string; uncertainty: string[] }[] = []): VisualSpec {
  const semantic = visualSemanticDto.parse(raw);
  const referenceOnly = asset.assetKind === "BRAND_MARK" || asset.assetKind === "UI_REFERENCE";
  const details = referenceOnly ? { referenceDerived: true, aiRedrawAllowed: false,
    referenceAttachmentIds: confirmedReferenceIds, referenceConstraints: [...asset.mustPreserve, ...asset.forbiddenChanges], observedReferenceNotes }
    : asset.assetKind === "MATERIAL_FX" ? compileMaterialFxDetails(asset, semantic)
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

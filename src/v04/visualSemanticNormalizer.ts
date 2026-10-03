import type { AssetKind } from "./assetWorkflow";

export const VISUAL_NORMALIZER_VERSION = "v04.visual-semantic.1";
export type VisualWarning = { path: string; code: string };
type RecordValue = Record<string, unknown>;
type Context = { warnings: VisualWarning[] };

export class VisualSemanticRootError extends Error {
  readonly code = "SEMANTIC_ROOT_INVALID";
  constructor(readonly path: string) { super("Visual semantic root is not a bounded object"); }
}

export function asRecord(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function unwrapSemanticRoot(raw: unknown): RecordValue {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(raw) ?? ""); }
  catch { throw new VisualSemanticRootError("$"); }
  if (size > 65536) throw new VisualSemanticRootError("$");
  let value = raw;
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(value)) {
      if (value.length !== 1) throw new VisualSemanticRootError("$");
      value = value[0]; continue;
    }
    if (!value || typeof value !== "object") throw new VisualSemanticRootError("$");
    const object = value as RecordValue;
    const wrapper = object.visualSpec ?? object.result;
    if (wrapper === undefined) return object;
    value = wrapper;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VisualSemanticRootError("$");
  return value as RecordValue;
}

const pick = (source: RecordValue, ...keys: string[]) => keys.map(key => source[key]).find(value => value !== undefined && value !== null);
export function asString(value: unknown, ctx: Context, path: string): string {
  if (value == null) return "";
  if (typeof value !== "string") { ctx.warnings.push({ path, code: "UNSUPPORTED_SCALAR" }); return ""; }
  const text = value.trim();
  if (text.length > 600) ctx.warnings.push({ path, code: "TRUNCATED_VALUE" });
  return text.slice(0, 600);
}
export function asStringList(value: unknown, ctx: Context, path: string): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  if (!Array.isArray(value)) ctx.warnings.push({ path, code: "SCALAR_TO_LIST" });
  const clean: string[] = [];
  for (const item of items) {
    if (item == null || item === "") continue;
    if (typeof item !== "string") { ctx.warnings.push({ path, code: "DROPPED_LIST_ITEM" }); continue; }
    const text = item.trim();
    if (text) clean.push(asString(text, ctx, path));
  }
  if (clean.length > 30) ctx.warnings.push({ path, code: "LIST_LIMIT" });
  return clean.slice(0, 30);
}
export function normalizeEnum<T extends string>(value: unknown, aliases: Record<string, T>, fallback: T, ctx: Context, path: string): T {
  if (value == null || value === "") return fallback;
  const normalized = typeof value === "string" ? value.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
  const result = aliases[normalized];
  if (!result) ctx.warnings.push({ path, code: "DEFAULTED_ENUM" });
  return result ?? fallback;
}
export function normalizePriority(value: unknown, ctx: Context, path: string): "LOW" | "MEDIUM" | "HIGH" {
  return normalizeEnum(value, { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", 低: "LOW", 中: "MEDIUM", 高: "HIGH" }, "LOW", ctx, path);
}

export function normalizeEmbeddedElements(raw: unknown, kind: AssetKind, ctx: Context) {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  if (items.length > 30) ctx.warnings.push({ path: "embeddedElements", code: "LIST_LIMIT" });
  return items.slice(0, 30).flatMap((item, index) => {
    const source = asRecord(item), path = `embeddedElements.${index}`;
    const name = asString(pick(source, "name", "elementName"), ctx, `${path}.name`);
    const placement = asString(pick(source, "placement", "location", "physicalPlacement"), ctx, `${path}.placement`);
    if (!name || (["HUMAN_CHARACTER", "CREATURE"].includes(kind) && !placement)) {
      ctx.warnings.push({ path, code: "DROPPED_EMBEDDED_ELEMENT" }); return [];
    }
    return [{ embeddedElementId: `embedded-${index + 1}`, name,
      visualDescription: asString(pick(source, "visualDescription", "description"), ctx, `${path}.visualDescription`), placement,
      continuityImportance: normalizePriority(source.continuityImportance, ctx, `${path}.continuityImportance`),
      promotionRecommendation: normalizePriority(source.promotionRecommendation, ctx, `${path}.promotionRecommendation`),
      suggestedCategory: null, suggestedAssetKind: null }];
  });
}

const materialStates = ["MIST", "PARTICLE", "SILHOUETTE", "SOLID"] as const;
type MaterialState = typeof materialStates[number];
const materialAliases: Record<string, MaterialState> = {
  MIST: "MIST", FOG: "MIST", VAPOR: "MIST", VAPOUR: "MIST", 雾: "MIST", 雾态: "MIST",
  PARTICLE: "PARTICLE", PARTICLES: "PARTICLE", CONDENSATION: "PARTICLE", 颗粒: "PARTICLE", 粒子: "PARTICLE", 凝聚: "PARTICLE",
  SILHOUETTE: "SILHOUETTE", CONTOUR: "SILHOUETTE", OUTLINE: "SILHOUETTE", EMERGING_FORM: "SILHOUETTE", 轮廓: "SILHOUETTE", 成形轮廓: "SILHOUETTE",
  SOLID: "SOLID", SOLID_FORM: "SOLID", MANIFESTED: "SOLID", ENTITY: "SOLID", FINAL_FORM: "SOLID", 实体: "SOLID", 实体态: "SOLID",
};
const materialCue: [MaterialState, RegExp][] = [
  ["MIST", /\b(mist|fog|vapor|vapour)\b|雾/iu],
  ["PARTICLE", /\b(particles?|grains?|condensation)\b|颗粒|粒子|凝聚/iu],
  ["SILHOUETTE", /\b(silhouette|contour|outline)\b|轮廓/iu],
  ["SOLID", /\b(solid|manifested|entity|final form)\b|实体/iu],
];
function materialKey(value: unknown): MaterialState | null {
  if (typeof value !== "string") return null;
  return materialAliases[value.trim().toUpperCase().replace(/[\s-]+/g, "_")] ?? null;
}
function materialKeyFromAppearance(text: string): MaterialState | null {
  const matches = materialCue.filter(([, cue]) => cue.test(text));
  return matches.length === 1 ? matches[0][0] : null;
}

export const visualDetailTemplates: Record<AssetKind, unknown> = {
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

type Asset = { assetKind: AssetKind; name: string; description: string; identityAnchors: string[]; mustPreserve: string[]; forbiddenChanges: string[] };
function normalizeCommon(source: RecordValue, asset: Asset, ctx: Context) {
  const string = (field: string) => asString(source[field], ctx, field);
  const list = (field: string) => asStringList(source[field], ctx, field);
  return {
    visualIdentitySummary: string("visualIdentitySummary") || asset.description.slice(0, 600) || asset.name.slice(0, 600),
    silhouette: string("silhouette"), scale: string("scale"), proportion: string("proportion"),
    primaryPalette: list("primaryPalette"), secondaryPalette: list("secondaryPalette"), materials: list("materials"),
    surfaceLanguage: string("surfaceLanguage"), distinctiveFeatures: list("distinctiveFeatures"),
    continuityNotes: list("continuityNotes"), identityAnchors: source.identityAnchors == null ? asset.identityAnchors : list("identityAnchors"),
    mustPreserve: source.mustPreserve == null ? asset.mustPreserve : list("mustPreserve"),
    forbiddenChanges: source.forbiddenChanges == null ? asset.forbiddenChanges : list("forbiddenChanges"),
    embeddedElements: normalizeEmbeddedElements(source.embeddedElements, asset.assetKind, ctx),
  };
}
function normalizeHumanDetails(d: RecordValue, ctx: Context) {
  const face = asRecord(d.face), hair = asRecord(d.hair), body = asRecord(d.body), wardrobe = asRecord(d.wardrobe);
  const field = (path: string, ...values: unknown[]) => asString(values.find(value => value != null), ctx, path);
  return {
    ageRange: field("details.ageRange", d.ageRange, d.age), genderPresentation: field("details.genderPresentation", d.genderPresentation, d.gender),
    face: { faceShape: field("details.face.faceShape", pick(face, "faceShape", "shape"), d.faceShape),
      facialFeatures: field("details.face.facialFeatures", face.facialFeatures, d.facialFeatures), skinTone: field("details.face.skinTone", face.skinTone, d.skinTone),
      eyeLanguage: field("details.face.eyeLanguage", face.eyeLanguage, d.eyeLanguage) },
    hair: { color: field("details.hair.color", hair.color, d.hairColor), length: field("details.hair.length", hair.length, d.hairLength),
      silhouette: field("details.hair.silhouette", hair.silhouette, d.hairSilhouette), styling: field("details.hair.styling", hair.styling, d.hairStyling) },
    body: { build: field("details.body.build", body.build, d.bodyBuild), heightProportion: field("details.body.heightProportion", body.heightProportion, d.heightProportion),
      ageProportion: field("details.body.ageProportion", body.ageProportion, d.ageProportion) },
    wardrobe: { upper: field("details.wardrobe.upper", wardrobe.upper, d.wardrobeUpper), lower: field("details.wardrobe.lower", wardrobe.lower, d.wardrobeLower),
      outer: field("details.wardrobe.outer", wardrobe.outer, d.wardrobeOuter), material: field("details.wardrobe.material", wardrobe.material, d.wardrobeMaterial),
      palette: field("details.wardrobe.palette", wardrobe.palette, d.wardrobePalette) },
    footwear: field("details.footwear", d.footwear), defaultExpression: field("details.defaultExpression", d.defaultExpression),
    expressionRange: asStringList(d.expressionRange, ctx, "details.expressionRange"),
  };
}
function normalizeCreatureDetails(d: RecordValue, ctx: Context) {
  const body = asRecord(d.body);
  const string = (path: string, ...values: unknown[]) => asString(values.find(value => value != null), ctx, path);
  return { speciesOrForm: string("details.speciesOrForm", d.speciesOrForm, d.species, d.form),
    bodyStructure: string("details.bodyStructure", d.bodyStructure, body.structure, d.body), anatomy: string("details.anatomy", d.anatomy),
    relativeScale: string("details.relativeScale", d.relativeScale, d.scale), surface: string("details.surface", d.surface),
    skinFurFeatherLanguage: string("details.skinFurFeatherLanguage", d.skinFurFeatherLanguage, d.skin, d.fur, d.feather),
    eyes: string("details.eyes", d.eyes), movementLanguage: string("details.movementLanguage", d.movementLanguage, d.movement) };
}
function normalizeVehicleDetails(d: RecordValue, ctx: Context) {
  const string = (path: string, ...values: unknown[]) => asString(values.find(value => value != null), ctx, path);
  return { vehicleType: string("details.vehicleType", d.vehicleType, d.type), overallSilhouette: string("details.overallSilhouette", d.overallSilhouette, d.silhouette),
    relativeScale: string("details.relativeScale", d.relativeScale, d.scale), mainStructure: string("details.mainStructure", d.mainStructure, d.structure),
    secondaryStructure: string("details.secondaryStructure", d.secondaryStructure), surfaceTreatment: string("details.surfaceTreatment", d.surfaceTreatment, d.surface),
    propulsion: string("details.propulsion", d.propulsion), windows: string("details.windows", d.windows), openings: string("details.openings", d.openings) };
}
function normalizeObjectDetails(d: RecordValue, ctx: Context) {
  const field = (path: string, ...values: unknown[]) => asString(values.find(value => value != null), ctx, path);
  return { objectType: field("details.objectType", d.objectType, d.type), structure: field("details.structure", d.structure, d.construction),
    use: field("details.use", d.use, d.purpose, d.function) };
}
function normalizeEnvironmentDetails(d: RecordValue, ctx: Context) {
  const aliases = { EMPTY_CANONICAL_REFERENCE: "EMPTY_CANONICAL_REFERENCE", EMPTY: "EMPTY_CANONICAL_REFERENCE", EMPTY_SCENE: "EMPTY_CANONICAL_REFERENCE",
    CANONICAL_EMPTY: "EMPTY_CANONICAL_REFERENCE", NO_SUBJECTS: "EMPTY_CANONICAL_REFERENCE", NO_PEOPLE: "EMPTY_CANONICAL_REFERENCE",
    空场景: "EMPTY_CANONICAL_REFERENCE", 无人物: "EMPTY_CANONICAL_REFERENCE", 无主体: "EMPTY_CANONICAL_REFERENCE",
    SUBJECTS_ALLOWED: "SUBJECTS_ALLOWED", WITH_SUBJECTS: "SUBJECTS_ALLOWED", 允许主体: "SUBJECTS_ALLOWED", 允许明确主体: "SUBJECTS_ALLOWED" } as const;
  const string = (field: string) => asString(d[field], ctx, `details.${field}`);
  return { spaceType: string("spaceType"), geography: string("geography"), layout: string("layout"), scale: string("scale"),
    foreground: string("foreground"), midground: string("midground"), background: string("background"),
    architectureOrNaturalForms: asStringList(d.architectureOrNaturalForms, ctx, "details.architectureOrNaturalForms"),
    timeOfDay: string("timeOfDay"), weather: string("weather"), atmosphere: string("atmosphere"), lighting: string("lighting"),
    recurringAnchors: asStringList(d.recurringAnchors, ctx, "details.recurringAnchors"),
    emptyEnvironmentPolicy: normalizeEnum(d.emptyEnvironmentPolicy, aliases, "EMPTY_CANONICAL_REFERENCE", ctx, "details.emptyEnvironmentPolicy") };
}
function normalizeMaterialFxDetails(d: RecordValue, asset: Asset, common: ReturnType<typeof normalizeCommon>, ctx: Context) {
  const string = (field: string) => asString(d[field], ctx, `details.${field}`);
  const baseColor = string("baseColor"), emissionColor = string("emissionColor"), particleLanguage = string("particleLanguage"), edgeLanguage = string("edgeLanguage");
  const raw = d.states;
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === "object"
    ? Object.entries(raw).map(([key, value]) => typeof value === "string" ? { key, appearance: value } : { ...asRecord(value), key }) : [];
  const keyed = new Map<MaterialState, string>(), unkeyed: string[] = [];
  for (const rawRow of rows) {
    const row = typeof rawRow === "string" ? { appearance: rawRow } : asRecord(rawRow);
    const appearance = asString(pick(row, "appearance", "description"), ctx, "details.states.appearance");
    if (!appearance) continue;
    const label = pick(row, "key", "name", "state", "phase", "label");
    const key = materialKey(label);
    if (key && !keyed.has(key)) keyed.set(key, appearance);
    else if (label == null) {
      const inferred = materialKeyFromAppearance(appearance);
      if (inferred && !keyed.has(inferred)) keyed.set(inferred, appearance);
      else if (!inferred) unkeyed.push(appearance);
    }
  }
  const identity = [asset.name, asset.description, common.visualIdentitySummary].filter(Boolean).join(" — ").slice(0, 320);
  const color = [baseColor, emissionColor, ...common.primaryPalette].filter(Boolean).join(", ").slice(0, 120);
  const cues = `${identity}${color ? `; color and glow: ${color}` : ""}`;
  const fallback: Record<MaterialState, string> = { MIST: `Diffuse mist phase of ${cues}`,
    PARTICLE: `Condensed particle phase of ${cues}; ${particleLanguage || "visible particles"}`,
    SILHOUETTE: `Particles gather into a recognizable silhouette of ${cues}; ${edgeLanguage || "continuous contour"}`,
    SOLID: `Coherent solid manifestation of ${cues}` };
  const states = materialStates.map(key => ({ key, appearance: keyed.get(key) ?? unkeyed.shift() ?? fallback[key].slice(0, 600) }));
  const rule = (field: string, fallback: string) => {
    const supplied = asStringList(d[field], ctx, `details.${field}`);
    return supplied.length ? supplied : [fallback];
  };
  return { baseColor, emissionColor, particleLanguage, edgeLanguage, density: string("density"), transparency: string("transparency"), states,
    transitionRules: rule("transitionRules", "Preserve one material identity and palette through MIST → PARTICLE → SILHOUETTE → SOLID."),
    interactionRules: rule("interactionRules", "Interactions preserve the same material identity and confirmed visual cues."),
    manifestationRules: rule("manifestationRules", "Manifestation follows MIST → PARTICLE → SILHOUETTE → SOLID without introducing a new identity.") };
}
function normalizeCelestialDetails(d: RecordValue, ctx: Context) {
  const field = (path: string, ...values: unknown[]) => asString(values.find(value => value != null), ctx, path);
  return { form: field("details.form", d.form), phase: field("details.phase", d.phase),
    surfaceOrGlow: field("details.surfaceOrGlow", d.surfaceOrGlow, d.surface, d.glow), halo: field("details.halo", d.halo),
    relativeScale: field("details.relativeScale", d.relativeScale, d.scale), palette: asStringList(d.palette, ctx, "details.palette"),
    compositionRole: field("details.compositionRole", d.compositionRole, d.role) };
}

export function normalizeVisualSemantic(raw: unknown, asset: Asset) {
  const source = unwrapSemanticRoot(raw), ctx: Context = { warnings: [] };
  const common = normalizeCommon(source, asset, ctx);
  const d = asRecord(source.details);
  const details = (() => {
    switch (asset.assetKind) {
      case "HUMAN_CHARACTER": return normalizeHumanDetails(d, ctx);
      case "CREATURE": return normalizeCreatureDetails(d, ctx);
      case "VEHICLE": return normalizeVehicleDetails(d, ctx);
      case "PROP": case "OTHER": return normalizeObjectDetails(d, ctx);
      case "ENVIRONMENT": return normalizeEnvironmentDetails(d, ctx);
      case "MATERIAL_FX": return normalizeMaterialFxDetails(d, asset, common, ctx);
      case "CELESTIAL": return normalizeCelestialDetails(d, ctx);
      case "BRAND_MARK": case "UI_REFERENCE": throw new VisualSemanticRootError("assetKind");
    }
  })();
  return { common, details, warnings: ctx.warnings };
}

export function visualQualityWarnings(spec: { assetKind: AssetKind; details: unknown }): VisualWarning[] {
  const details = asRecord(spec.details), warnings: VisualWarning[] = [];
  const fields: [string, unknown][] = spec.assetKind === "HUMAN_CHARACTER" ? [
    ["details.footwear", details.footwear], ["details.wardrobe.upper", asRecord(details.wardrobe).upper],
    ["details.wardrobe.lower", asRecord(details.wardrobe).lower], ["details.hair.color", asRecord(details.hair).color],
  ] : spec.assetKind === "CREATURE" ? [["details.speciesOrForm", details.speciesOrForm], ["details.anatomy", details.anatomy]] : [];
  for (const [path, value] of fields) if (typeof value === "string" && /\b(either\b.+\bor\b|optional)\b|或|可选|[A-Za-z]+\s*\/\s*[A-Za-z]+/iu.test(value))
    warnings.push({ path, code: "AMBIGUOUS_IDENTITY_VALUE" });
  return warnings;
}

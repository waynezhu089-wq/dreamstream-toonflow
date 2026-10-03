import { z } from "zod";
import { normalizeAssetExtraction } from "./assetExtractionOutput";

// The text model describes creative entities and links. This is deliberately not
// the persisted Asset Bible schema: category, source policy, indexes, passes and
// coverage classification are compiled and checked on the server.
const text = (max: number) => z.string().trim().min(1).max(max);
const element = z.object({
  name: text(256), type: text(64), description: z.string().max(4000).default(""),
  core: z.boolean().optional(), realSourceRequired: z.boolean().optional(),
  existingCanonicalKey: text(128).optional(),
  relatedNames: z.array(text(256)).max(30).optional(),
  sharedVisualSystemName: text(256).optional(),
}).passthrough();
const beat = z.object({
  label: text(200), type: text(64).optional(),
  elementNames: z.array(text(256)).max(20).optional(),
  existingCanonicalKeys: z.array(text(128)).max(20).optional(),
  note: z.string().max(600).optional(),
}).passthrough();
export const assetExtractionSemanticSchema = z.object({
  visualElements: z.array(element).max(80),
  coverage: z.array(beat).max(100),
}).passthrough();

export type ExistingIdentity = { canonicalKey: string; name: string; category: string };
type Kind = "HUMAN_CHARACTER" | "CREATURE" | "VEHICLE" | "PROP" | "ENVIRONMENT" | "CELESTIAL" | "MATERIAL_FX" | "BRAND_MARK" | "UI_REFERENCE";
const kindCategory: Record<Kind, string> = {
  HUMAN_CHARACTER: "CHAR", CREATURE: "CHAR", VEHICLE: "PROP", PROP: "PROP",
  ENVIRONMENT: "LOC", CELESTIAL: "LOC", MATERIAL_FX: "FX", BRAND_MARK: "BRAND", UI_REFERENCE: "UI",
};
const kindCoverage: Record<Kind, string> = {
  HUMAN_CHARACTER: "PERSON", CREATURE: "CREATURE", VEHICLE: "VEHICLE", PROP: "PROP",
  ENVIRONMENT: "SCENE", CELESTIAL: "SCENE", MATERIAL_FX: "FX_MATERIAL", BRAND_MARK: "BRAND", UI_REFERENCE: "OTHER",
};
const kindByMeaning: Record<string, Kind> = {
  HUMAN_CHARACTER: "HUMAN_CHARACTER", PERSON: "HUMAN_CHARACTER", HUMAN: "HUMAN_CHARACTER", CHARACTER: "HUMAN_CHARACTER", 人物: "HUMAN_CHARACTER", 角色: "HUMAN_CHARACTER", 男孩: "HUMAN_CHARACTER",
  CREATURE: "CREATURE", ANIMAL: "CREATURE", 生物: "CREATURE", 动物: "CREATURE",
  VEHICLE: "VEHICLE", TRANSPORT: "VEHICLE", 载具: "VEHICLE", 交通工具: "VEHICLE",
  PROP: "PROP", OBJECT: "PROP", 道具: "PROP",
  ENVIRONMENT: "ENVIRONMENT", SCENE: "ENVIRONMENT", LOCATION: "ENVIRONMENT", PLACE: "ENVIRONMENT", ENV: "ENVIRONMENT", 场景: "ENVIRONMENT", 环境: "ENVIRONMENT", 地点: "ENVIRONMENT",
  CELESTIAL: "CELESTIAL", MOON: "CELESTIAL", 天体: "CELESTIAL", 月亮: "CELESTIAL",
  MATERIAL_FX: "MATERIAL_FX", VISUAL_SYSTEM: "MATERIAL_FX", SHARED_VISUAL_SYSTEM: "MATERIAL_FX", FX_SYSTEM: "MATERIAL_FX", FX: "MATERIAL_FX", MATERIAL: "MATERIAL_FX", 视觉系统: "MATERIAL_FX", 共享视觉系统: "MATERIAL_FX", 材质: "MATERIAL_FX", 特效: "MATERIAL_FX",
  BRAND_MARK: "BRAND_MARK", BRAND: "BRAND_MARK", LOGO: "BRAND_MARK", 品牌: "BRAND_MARK", 标志: "BRAND_MARK",
  UI_REFERENCE: "UI_REFERENCE", UI: "UI_REFERENCE", INTERFACE: "UI_REFERENCE", 界面: "UI_REFERENCE",
};
const composition = new Set(["COMPOSITION", "COMPOSITION_GOAL", "COMPOSITION_MOTIF", "构图", "构图目标", "终场构图"]);
const labelKey = (value: string) => value.normalize("NFKC").trim().toUpperCase().replace(/[\s./-]+/g, "_");
const identityKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
function invalid(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: "custom", path, message }]);
}
function kindFor(value: string, path: (string | number)[]): Kind {
  return kindByMeaning[labelKey(value)] ?? invalid(path, "视觉元素类型无法确定，不能猜测 canonical 类型");
}
function uniqueNames<T extends { name: string }>(rows: T[], path: string) {
  const byName = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = identityKey(row.name);
    if (byName.has(key)) invalid([path, index, "name"], "同名视觉元素不能重复建立身份");
    byName.set(key, index);
  });
  return byName;
}

export function compileAssetExtractionSemantic(raw: unknown, existing: ExistingIdentity[]) {
  const model = assetExtractionSemanticSchema.parse(raw);
  const nameIndex = uniqueNames(model.visualElements, "visualElements");
  const existingKeys = new Set(existing.map(item => item.canonicalKey));
  const existingByKey = new Map(existing.map(item => [item.canonicalKey, item]));
  const existingByName = new Map(existing.map(item => [identityKey(item.name), item]));
  const resolveName = (name: string, path: (string | number)[]) => {
    const index = nameIndex.get(identityKey(name));
    if (index === undefined) invalid(path, "引用的视觉元素不存在");
    return model.visualElements[index].name;
  };
  const kinds = model.visualElements.map((item, i) => kindFor(item.type, ["visualElements", i, "type"]));
  const mergeSuggestions: { candidateRef: string; existingCanonicalKey: string; reason: string }[] = [];
  const candidates = model.visualElements.map((item, i) => {
    const kind = kinds[i];
    const category = kindCategory[kind];
    const exactMatch = existingByName.get(identityKey(item.name));
    const uniqueBrand = category === "BRAND" && existing.filter(asset => asset.category === "BRAND").length === 1
      && /logo|标志|品牌/i.test(item.name) ? existing.find(asset => asset.category === "BRAND") : null;
    const existingKey = item.existingCanonicalKey ?? (exactMatch?.category === category ? exactMatch.canonicalKey : null)
      ?? uniqueBrand?.canonicalKey;
    if (existingKey && !existingKeys.has(existingKey)) invalid(["visualElements", i, "existingCanonicalKey"], "合并目标不属于当前项目");
    if (existingKey && existing.find(asset => asset.canonicalKey === existingKey)?.category !== category)
      invalid(["visualElements", i, "existingCanonicalKey"], "合并目标类别不一致");
    if (existingKey) mergeSuggestions.push({ candidateRef: item.name, existingCanonicalKey: existingKey, reason: "已存在的 canonical identity，仅建议合并" });
    // Relationship judgement belongs to the separate exact-name phase. Any
    // incidental fields from the entity phase are advisory, never authority.
    return {
      name: item.name, localRef: item.name, category, assetKind: kind, description: item.description,
      sourcePolicy: category === "BRAND" || category === "UI" || item.realSourceRequired ? "REAL_REQUIRED" : "AI_ALLOWED",
      importance: (item.core ?? ["HUMAN_CHARACTER", "CREATURE", "VEHICLE", "PROP"].includes(kind)) ? "CORE" : "SUPPORTING",
      relatedCandidateRefs: [], relatedExistingKeys: [],
      sharedVisualSystemRef: null, sharedVisualSystemKey: null,
      ownerKey: null, variantOf: null,
    };
  });
  const coverage = model.coverage.map((item, i) => {
    const candidateRefs = (item.elementNames ?? []).map((name, j) => resolveName(name, ["coverage", i, "elementNames", j]));
    const candidateKinds = candidateRefs.map(name => kinds[nameIndex.get(identityKey(name))!]);
    for (const [j, key] of (item.existingCanonicalKeys ?? []).entries())
      if (!existingKeys.has(key)) invalid(["coverage", i, "existingCanonicalKeys", j], "覆盖引用不属于当前项目");
    const type = item.type ? labelKey(item.type) : null;
    const isComposition = type !== null && composition.has(type);
    const declaredKind = type ? kindByMeaning[type] : null;
    // A beat can mention a scene while linking an entity; its type is not the
    // entity's identity. Reject a true direct-identity contradiction, but do
    // not make the model serialize duplicate category facts for every beat.
    const directIdentity = candidateRefs.length === 1 && identityKey(item.label) === identityKey(candidateRefs[0]);
    if (directIdentity && declaredKind && candidateKinds.length && candidateKinds.every(kind => kindCoverage[kind] === kindCoverage[candidateKinds[0]])
      && kindCoverage[declaredKind] !== kindCoverage[candidateKinds[0]])
      invalid(["coverage", i, "type"], "覆盖类别与绑定视觉元素矛盾");
    const existingTypes = (item.existingCanonicalKeys ?? []).map(key => {
      const category = existingByKey.get(key)!.category;
      return category === "BRAND" ? "BRAND" : category === "LOC" ? "SCENE" : null;
    });
    let coverageType: string;
    if (isComposition) coverageType = "COMPOSITION_GOAL";
    else if (candidateKinds.length && candidateKinds.every(kind => kindCoverage[kind] === kindCoverage[candidateKinds[0]]))
      coverageType = kindCoverage[candidateKinds[0]];
    else if (type && kindByMeaning[type]) coverageType = kindCoverage[kindByMeaning[type]];
    else if (existingTypes.length && existingTypes.every(value => value && value === existingTypes[0])) coverageType = existingTypes[0]!;
    else if (type === "OTHER" || type === "其他") coverageType = "OTHER";
    else invalid(["coverage", i, "type"], "无关联元素时必须给出可确定的视觉类型");
    const hasReference = candidateRefs.length > 0 || (item.existingCanonicalKeys?.length ?? 0) > 0;
    const classification = isComposition ? "COMPOSITION_MOTIF"
      : candidateKinds.length && candidateKinds.every(kind => kind === "MATERIAL_FX") ? "VISUAL_SYSTEM"
      : candidateRefs.length && candidateRefs.every(name => candidates[nameIndex.get(identityKey(name))!].variantOf) ? "VARIANT"
      : coverageType === "SCENE" ? "SCENE_ANCHOR"
      : hasReference ? "CANONICAL_ASSET" : "SHOT_LOCAL";
    return { label: item.label, coverageType, classification, candidateRefs,
      existingCanonicalKeys: item.existingCanonicalKeys ?? [], note: item.note ?? "" };
  });
  for (const [index, kind] of kinds.entries()) {
    if (kind !== "MATERIAL_FX") continue;
    if (coverage.some(item => item.classification === "VISUAL_SYSTEM" && item.candidateRefs.length === 1
      && identityKey(item.candidateRefs[0]) === identityKey(model.visualElements[index].name))) continue;
    // An extracted shared material deserves an explicit audit row. This does
    // not invent any additional Treatment beat or make missing beats covered.
    coverage.push({ label: model.visualElements[index].name, coverageType: "FX_MATERIAL",
      classification: "VISUAL_SYSTEM", candidateRefs: [model.visualElements[index].name], existingCanonicalKeys: [], note: "持续视觉系统身份" });
  }
  // This established compiler validates indexes, relationship ownership and the
  // exact persisted Proposal shape; no model output can bypass it.
  return normalizeAssetExtraction({ candidates, mergeSuggestions, coverage });
}

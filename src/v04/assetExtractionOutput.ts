import { z } from "zod";
import { assetKinds } from "./assetWorkflow";

const category = z.enum(["CHAR", "ACC", "PROP", "PRODUCT", "LOC", "BRAND", "UI", "FX"]);
const assetKind = z.enum(assetKinds);
const importance = z.enum(["CORE", "SUPPORTING"]);
const extractionPass = z.enum(["ENTITY", "ENVIRONMENT", "VISUAL_SYSTEM"]);
const coverageType = z.enum(["PERSON", "CREATURE", "VEHICLE", "SCENE", "FX_MATERIAL", "BRAND", "COMPOSITION_GOAL", "PROP", "OTHER"]);
const classification = z.enum(["CANONICAL_ASSET", "VARIANT", "SCENE_ANCHOR", "VISUAL_SYSTEM", "SHOT_LOCAL", "COMPOSITION_MOTIF"]);
const index = z.number().int().nonnegative();
const modelLabel = z.string().trim().min(1).max(64);

// The model describes identities and relationships. Persisted proposal fields remain strict.
// Legacy index-shaped output is accepted so an in-flight provider response can still be repaired.
export const assetExtractionModelSchema = z.object({
  candidates: z.array(z.object({
    name: z.string().trim().min(1).max(256), category: modelLabel,
    description: z.string().max(4000), sourcePolicy: modelLabel,
    localRef: z.string().trim().min(1).max(128).nullish(), assetKind: modelLabel.nullish(), importance: modelLabel.nullish(),
    extractionPass: modelLabel.nullish(), identityAnchors: z.array(z.string().max(300)).max(30).nullish(),
    mustPreserve: z.array(z.string().max(300)).max(30).nullish(), forbiddenChanges: z.array(z.string().max(300)).max(30).nullish(),
    ownerKey: z.string().max(128).nullable().optional(), variantOf: z.string().max(128).nullable().optional(),
    prompt: z.string().max(8000).nullish(), relatedExistingKeys: z.array(z.string()).max(30).nullish(),
    relatedCandidateRefs: z.array(z.string()).max(30).nullish(), relatedCandidateIndexes: z.array(index).max(30).nullish(),
    sharedVisualSystemKey: z.string().nullish(), sharedVisualSystemRef: z.string().nullish(),
    sharedVisualSystemCandidateIndex: index.nullish(),
  }).strict()).max(80),
  mergeSuggestions: z.array(z.object({
    candidateRef: z.string().nullish(), candidateIndex: index.nullish(),
    existingCanonicalKey: z.string(), reason: z.string(),
  }).strict()).max(80).nullish(),
  coverage: z.array(z.object({
    label: z.string().trim().min(1).max(200), coverageType: modelLabel.nullish(), classification: modelLabel,
    candidateRefs: z.array(z.string()).max(20).nullish(), candidateIndexes: z.array(index).max(20).nullish(),
    existingCanonicalKeys: z.array(z.string()).max(20).nullish(), note: z.string().max(600).nullish(),
  }).strict()).max(100).nullish(),
}).strict();

export const assetExtractionProposalSchema = z.object({
  candidates: z.array(z.object({
    name: z.string().trim().min(1).max(256), category, description: z.string().max(4000),
    identityAnchors: z.array(z.string().max(300)).max(30), mustPreserve: z.array(z.string().max(300)).max(30),
    forbiddenChanges: z.array(z.string().max(300)).max(30), ownerKey: z.string().max(128).nullable(),
    variantOf: z.string().max(128).nullable(), sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]),
    prompt: z.string().max(8000), assetKind, importance, relatedExistingKeys: z.array(z.string()).max(30),
    relatedCandidateIndexes: z.array(index).max(30), sharedVisualSystemKey: z.string().nullable(),
    sharedVisualSystemCandidateIndex: index.nullable(), extractionPass,
  }).strict()).max(80),
  mergeSuggestions: z.array(z.object({ candidateIndex: index, existingCanonicalKey: z.string(), reason: z.string() }).strict()).max(80),
  coverage: z.array(z.object({ label: z.string().trim().min(1).max(200), coverageType, classification,
    candidateIndexes: z.array(index).max(20), existingCanonicalKeys: z.array(z.string()).max(20), note: z.string().max(600) }).strict()).max(100),
}).strict();

const kindDefaults: Record<z.infer<typeof category>, z.infer<typeof assetKind> | null> = {
  CHAR: null, ACC: "PROP", PROP: null, PRODUCT: null, LOC: "ENVIRONMENT", BRAND: "BRAND_MARK", UI: "UI_REFERENCE", FX: "MATERIAL_FX",
};

// Only known synonyms cross this boundary. The canonical proposal still uses the exact enums above.
const categoryAliases: Record<string, string> = {
  CHARACTER: "CHAR", PERSON: "CHAR", HUMAN: "CHAR", CREATURE: "CHAR", ANIMAL: "CHAR", 角色: "CHAR", 人物: "CHAR", 生物: "CHAR", 动物: "CHAR",
  ACCESSORY: "ACC", ACCESSORIES: "ACC", 配饰: "ACC", 饰品: "ACC",
  OBJECT: "PROP", ITEM: "PROP", VEHICLE: "PROP", TRANSPORT: "PROP", 道具: "PROP", 载具: "PROP", 交通工具: "PROP",
  产品: "PRODUCT", 商品: "PRODUCT",
  LOCATION: "LOC", ENVIRONMENT: "LOC", SCENE: "LOC", SETTING: "LOC", 场景: "LOC", 环境: "LOC", 地点: "LOC", 空间: "LOC",
  LOGO: "BRAND", BRAND_MARK: "BRAND", BRANDING: "BRAND", 品牌: "BRAND", 品牌标识: "BRAND", 标志: "BRAND",
  INTERFACE: "UI", USER_INTERFACE: "UI", APP_UI: "UI", SCREEN: "UI", 界面: "UI", 产品界面: "UI", 屏幕: "UI",
  VISUAL_SYSTEM: "FX", MATERIAL: "FX", MATERIAL_FX: "FX", EFFECT: "FX", EFFECTS: "FX", VFX: "FX", 特效: "FX", 视觉系统: "FX", 材质: "FX",
};
const categoryKindHints: Record<string, z.infer<typeof assetKind>> = {
  PERSON: "HUMAN_CHARACTER", HUMAN: "HUMAN_CHARACTER", 人物: "HUMAN_CHARACTER",
  CREATURE: "CREATURE", ANIMAL: "CREATURE", 生物: "CREATURE", 动物: "CREATURE",
  VEHICLE: "VEHICLE", TRANSPORT: "VEHICLE", 载具: "VEHICLE", 交通工具: "VEHICLE",
  ENVIRONMENT: "ENVIRONMENT", LOCATION: "ENVIRONMENT", SCENE: "ENVIRONMENT", 场景: "ENVIRONMENT", 环境: "ENVIRONMENT",
  VISUAL_SYSTEM: "MATERIAL_FX", MATERIAL: "MATERIAL_FX", MATERIAL_FX: "MATERIAL_FX", 视觉系统: "MATERIAL_FX", 材质: "MATERIAL_FX",
  LOGO: "BRAND_MARK", 品牌标识: "BRAND_MARK", INTERFACE: "UI_REFERENCE", 产品界面: "UI_REFERENCE",
};
const specificCategoryKinds = new Set([
  "PERSON", "HUMAN", "人物", "CREATURE", "ANIMAL", "生物", "动物", "VEHICLE", "TRANSPORT", "载具", "交通工具",
  "VISUAL_SYSTEM", "MATERIAL", "MATERIAL_FX", "视觉系统", "材质", "LOGO", "品牌标识", "INTERFACE", "产品界面",
]);
const kindAliases: Record<string, string> = {
  CHARACTER: "HUMAN_CHARACTER", PERSON: "HUMAN_CHARACTER", HUMAN: "HUMAN_CHARACTER", 人物: "HUMAN_CHARACTER", 人类角色: "HUMAN_CHARACTER",
  ANIMAL: "CREATURE", BEAST: "CREATURE", 生物: "CREATURE", 动物: "CREATURE",
  TRANSPORT: "VEHICLE", 载具: "VEHICLE", 交通工具: "VEHICLE",
  OBJECT: "PROP", ITEM: "PROP", 道具: "PROP",
  SCENE: "ENVIRONMENT", LOCATION: "ENVIRONMENT", SETTING: "ENVIRONMENT", 场景: "ENVIRONMENT", 环境: "ENVIRONMENT",
  VISUAL_SYSTEM: "MATERIAL_FX", MATERIAL: "MATERIAL_FX", FX: "MATERIAL_FX", EFFECT: "MATERIAL_FX", VFX: "MATERIAL_FX", 视觉系统: "MATERIAL_FX", 材质: "MATERIAL_FX", 特效: "MATERIAL_FX",
  SKY: "CELESTIAL", MOON: "CELESTIAL", 天体: "CELESTIAL", 星体: "CELESTIAL",
  LOGO: "BRAND_MARK", BRAND: "BRAND_MARK", 品牌: "BRAND_MARK", 品牌标识: "BRAND_MARK",
  UI: "UI_REFERENCE", INTERFACE: "UI_REFERENCE", APP_SCREEN: "UI_REFERENCE", 界面: "UI_REFERENCE", 产品界面: "UI_REFERENCE",
  其他: "OTHER",
};
const importanceAliases: Record<string, string> = { PRIMARY: "CORE", MAIN: "CORE", HERO: "CORE", 主要: "CORE", 核心: "CORE", 重要: "CORE", SECONDARY: "SUPPORTING", BACKGROUND: "SUPPORTING", 辅助: "SUPPORTING", 次要: "SUPPORTING" };
const passAliases: Record<string, string> = { CHARACTER: "ENTITY", ASSET: "ENTITY", 人物: "ENTITY", 实体: "ENTITY", SCENE: "ENVIRONMENT", LOCATION: "ENVIRONMENT", 场景: "ENVIRONMENT", 环境: "ENVIRONMENT", VISUAL: "VISUAL_SYSTEM", MATERIAL: "VISUAL_SYSTEM", FX: "VISUAL_SYSTEM", VFX: "VISUAL_SYSTEM", 材质: "VISUAL_SYSTEM", 特效: "VISUAL_SYSTEM", 视觉系统: "VISUAL_SYSTEM" };
const policyAliases: Record<string, string> = { REAL: "REAL_REQUIRED", REAL_UPLOAD: "REAL_REQUIRED", UPLOAD_REQUIRED: "REAL_REQUIRED", 真实上传: "REAL_REQUIRED", 必须上传真实素材: "REAL_REQUIRED", AI: "AI_ALLOWED", AI_GENERATED: "AI_ALLOWED", 允许AI生成: "AI_ALLOWED", 可AI生成: "AI_ALLOWED" };
const coverageAliases: Record<string, string> = {
  HUMAN: "PERSON", 人物: "PERSON", 人: "PERSON", 生物: "CREATURE", 动物: "CREATURE", 载具: "VEHICLE", 交通工具: "VEHICLE",
  ENVIRONMENT: "SCENE", LOCATION: "SCENE", 场景: "SCENE", 环境: "SCENE", 地点: "SCENE",
  FX: "FX_MATERIAL", MATERIAL: "FX_MATERIAL", VISUAL_SYSTEM: "FX_MATERIAL", EFFECT: "FX_MATERIAL", 视觉系统: "FX_MATERIAL", 材质: "FX_MATERIAL", 特效: "FX_MATERIAL",
  LOGO: "BRAND", BRAND_MARK: "BRAND", 品牌: "BRAND", 品牌标识: "BRAND",
  COMPOSITION: "COMPOSITION_GOAL", COMPOSITION_TARGET: "COMPOSITION_GOAL", 构图: "COMPOSITION_GOAL", 构图目标: "COMPOSITION_GOAL",
  OBJECT: "PROP", ITEM: "PROP", 道具: "PROP", 其他: "OTHER",
};
const classificationAliases: Record<string, string> = {
  ASSET: "CANONICAL_ASSET", CANONICAL: "CANONICAL_ASSET", 标准资产: "CANONICAL_ASSET", 正式资产: "CANONICAL_ASSET", 资产: "CANONICAL_ASSET",
  变体: "VARIANT", 场景锚点: "SCENE_ANCHOR", 场景参考: "SCENE_ANCHOR", 视觉系统: "VISUAL_SYSTEM",
  SHOT_SPECIFIC: "SHOT_LOCAL", 镜头局部: "SHOT_LOCAL", 局部: "SHOT_LOCAL", COMPOSITION: "COMPOSITION_MOTIF", 构图母题: "COMPOSITION_MOTIF",
};

function labelKey(value: string) { return value.normalize("NFKC").trim().toUpperCase().replace(/[\s./-]+/g, "_"); }
function canonicalLabel<T extends z.ZodTypeAny>(value: string, schema: T, aliases: Record<string, string>, path: (string | number)[]): z.infer<T> {
  const key = labelKey(value);
  const parsed = schema.safeParse(aliases[key] ?? key);
  if (!parsed.success) invalid(path, "未知或歧义的语义标签");
  return parsed.data;
}

function inferredCoverageType(item: { category: z.infer<typeof category>; assetKind: z.infer<typeof assetKind> }) {
  if (item.category === "BRAND") return "BRAND";
  switch (item.assetKind) {
    case "HUMAN_CHARACTER": return "PERSON";
    case "CREATURE": return "CREATURE";
    case "VEHICLE": return "VEHICLE";
    case "PROP": return "PROP";
    case "ENVIRONMENT": return "SCENE";
    case "MATERIAL_FX": return "FX_MATERIAL";
    default: return null;
  }
}

function invalid(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: "custom", path, message }]);
}

export function normalizeAssetExtraction(raw: unknown) {
  const model = assetExtractionModelSchema.parse(raw);
  const refs = new Map<string, number>();
  model.candidates.forEach((item, i) => {
    for (const ref of [item.name, item.localRef].filter((value): value is string => !!value)) {
      const key = ref.trim().toLocaleLowerCase();
      if (refs.has(key) && refs.get(key) !== i) invalid(["candidates", i, "localRef"], "候选名称或本地引用不唯一");
      refs.set(key, i);
    }
  });
  const resolve = (ref: string, path: (string | number)[]) => {
    const found = refs.get(ref.trim().toLocaleLowerCase());
    if (found === undefined) return invalid(path, "候选引用不存在");
    return found;
  };
  const candidates = model.candidates.map((item, i) => {
    const categoryKey = labelKey(item.category);
    const normalizedCategory = canonicalLabel(item.category, category, categoryAliases, ["candidates", i, "category"]);
    const hint = categoryKindHints[categoryKey];
    const kind = item.assetKind
      ? canonicalLabel(item.assetKind, assetKind, kindAliases, ["candidates", i, "assetKind"])
      : hint ?? kindDefaults[normalizedCategory];
    if (!kind) invalid(["candidates", i, "assetKind"], "此类别需要明确资产子类型");
    if (hint && specificCategoryKinds.has(categoryKey) && kind !== hint)
      invalid(["candidates", i, "assetKind"], "类别与资产子类型冲突");
      const inferredImportance = ["ENVIRONMENT", "MATERIAL_FX", "CELESTIAL", "BRAND_MARK", "UI_REFERENCE"].includes(kind) ? "SUPPORTING" : null;
      const resolvedImportance = item.importance
        ? canonicalLabel(item.importance, importance, importanceAliases, ["candidates", i, "importance"])
        : inferredImportance;
      if (!resolvedImportance) invalid(["candidates", i, "importance"], "人物与物件的重要性需要明确判断");
      const candidateRefs = (item.relatedCandidateRefs ?? []).map((ref, j) => resolve(ref, ["candidates", i, "relatedCandidateRefs", j]));
      const systemRef = item.sharedVisualSystemRef;
      const systemIndex = systemRef ? resolve(systemRef, ["candidates", i, "sharedVisualSystemRef"]) : null;
      if (systemIndex !== null && item.sharedVisualSystemCandidateIndex != null && systemIndex !== item.sharedVisualSystemCandidateIndex)
        invalid(["candidates", i, "sharedVisualSystemRef"], "同一视觉系统的引用相互冲突");
      return {
        name: item.name, category: normalizedCategory, description: item.description,
        sourcePolicy: canonicalLabel(item.sourcePolicy, z.enum(["REAL_REQUIRED", "AI_ALLOWED"]), policyAliases, ["candidates", i, "sourcePolicy"]),
        assetKind: kind, importance: resolvedImportance,
        extractionPass: item.extractionPass
          ? canonicalLabel(item.extractionPass, extractionPass, passAliases, ["candidates", i, "extractionPass"])
          : normalizedCategory === "LOC" ? "ENVIRONMENT" : normalizedCategory === "FX" ? "VISUAL_SYSTEM" : "ENTITY",
        identityAnchors: item.identityAnchors ?? [], mustPreserve: item.mustPreserve ?? [], forbiddenChanges: item.forbiddenChanges ?? [],
        ownerKey: item.ownerKey ?? null, variantOf: item.variantOf ?? null, prompt: item.prompt ?? "",
        relatedExistingKeys: item.relatedExistingKeys ?? [], relatedCandidateIndexes: [...new Set([...(item.relatedCandidateIndexes ?? []), ...candidateRefs])],
        sharedVisualSystemKey: item.sharedVisualSystemKey ?? null,
        sharedVisualSystemCandidateIndex: systemIndex ?? item.sharedVisualSystemCandidateIndex ?? null,
      };
    });
  const normalized = {
    candidates,
    mergeSuggestions: (model.mergeSuggestions ?? []).map((item, i) => {
      const refIndex = item.candidateRef ? resolve(item.candidateRef, ["mergeSuggestions", i, "candidateRef"]) : null;
      if (refIndex !== null && item.candidateIndex != null && refIndex !== item.candidateIndex)
        invalid(["mergeSuggestions", i, "candidateRef"], "合并建议的引用相互冲突");
      return { candidateIndex: refIndex ?? item.candidateIndex ?? invalid(["mergeSuggestions", i, "candidateRef"], "合并建议缺少候选引用"),
        existingCanonicalKey: item.existingCanonicalKey, reason: item.reason };
    }),
    coverage: (model.coverage ?? []).map((item, i) => {
      const candidateIndexes = [...new Set([...(item.candidateIndexes ?? []), ...(item.candidateRefs ?? []).map((ref, j) => resolve(ref, ["coverage", i, "candidateRefs", j]))])];
      const inferred = candidateIndexes.map(candidateIndex => candidates[candidateIndex])
        .filter((candidate): candidate is (typeof candidates)[number] => !!candidate)
        .map(inferredCoverageType);
      const uniqueInferred = [...new Set(inferred)];
      const deterministic = candidateIndexes.length > 0 && inferred.length === candidateIndexes.length && uniqueInferred.length === 1
        ? uniqueInferred[0] : null;
      return {
        label: item.label,
        coverageType: deterministic ?? (item.coverageType
          ? canonicalLabel(item.coverageType, coverageType, coverageAliases, ["coverage", i, "coverageType"])
          : invalid(["coverage", i, "coverageType"], "无法从候选资产确定覆盖类别")),
        classification: canonicalLabel(item.classification, classification, classificationAliases, ["coverage", i, "classification"]),
        candidateIndexes, existingCanonicalKeys: item.existingCanonicalKeys ?? [], note: item.note ?? "",
      };
    }),
  };
  return assetExtractionProposalSchema.parse(normalized);
}

import { z } from "zod";
import { assetKinds } from "./assetWorkflow";

const category = z.enum(["CHAR", "ACC", "PROP", "PRODUCT", "LOC", "BRAND", "UI", "FX"]);
const assetKind = z.enum(assetKinds);
const importance = z.enum(["CORE", "SUPPORTING"]);
const extractionPass = z.enum(["ENTITY", "ENVIRONMENT", "VISUAL_SYSTEM"]);
const coverageType = z.enum(["PERSON", "CREATURE", "VEHICLE", "SCENE", "FX_MATERIAL", "BRAND", "COMPOSITION_GOAL", "PROP", "OTHER"]);
const classification = z.enum(["CANONICAL_ASSET", "VARIANT", "SCENE_ANCHOR", "VISUAL_SYSTEM", "SHOT_LOCAL", "COMPOSITION_MOTIF"]);
const index = z.number().int().nonnegative();

// The model describes identities and relationships. Persisted proposal fields remain strict.
// Legacy index-shaped output is accepted so an in-flight provider response can still be repaired.
export const assetExtractionModelSchema = z.object({
  candidates: z.array(z.object({
    name: z.string().trim().min(1).max(256), category,
    description: z.string().max(4000), sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]),
    localRef: z.string().trim().min(1).max(128).nullish(), assetKind: assetKind.nullish(), importance: importance.nullish(),
    extractionPass: extractionPass.nullish(), identityAnchors: z.array(z.string().max(300)).max(30).nullish(),
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
    label: z.string().trim().min(1).max(200), coverageType, classification,
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
  const normalized = {
    candidates: model.candidates.map((item, i) => {
      const kind = item.assetKind ?? kindDefaults[item.category];
      if (!kind) invalid(["candidates", i, "assetKind"], "此类别需要明确资产子类型");
      const inferredImportance = ["ENVIRONMENT", "MATERIAL_FX", "CELESTIAL", "BRAND_MARK", "UI_REFERENCE"].includes(kind) ? "SUPPORTING" : null;
      const resolvedImportance = item.importance ?? inferredImportance;
      if (!resolvedImportance) invalid(["candidates", i, "importance"], "人物与物件的重要性需要明确判断");
      const candidateRefs = (item.relatedCandidateRefs ?? []).map((ref, j) => resolve(ref, ["candidates", i, "relatedCandidateRefs", j]));
      const systemRef = item.sharedVisualSystemRef;
      const systemIndex = systemRef ? resolve(systemRef, ["candidates", i, "sharedVisualSystemRef"]) : null;
      if (systemIndex !== null && item.sharedVisualSystemCandidateIndex != null && systemIndex !== item.sharedVisualSystemCandidateIndex)
        invalid(["candidates", i, "sharedVisualSystemRef"], "同一视觉系统的引用相互冲突");
      return {
        name: item.name, category: item.category, description: item.description, sourcePolicy: item.sourcePolicy,
        assetKind: kind, importance: resolvedImportance,
        extractionPass: item.extractionPass ?? (item.category === "LOC" ? "ENVIRONMENT" : item.category === "FX" ? "VISUAL_SYSTEM" : "ENTITY"),
        identityAnchors: item.identityAnchors ?? [], mustPreserve: item.mustPreserve ?? [], forbiddenChanges: item.forbiddenChanges ?? [],
        ownerKey: item.ownerKey ?? null, variantOf: item.variantOf ?? null, prompt: item.prompt ?? "",
        relatedExistingKeys: item.relatedExistingKeys ?? [], relatedCandidateIndexes: [...new Set([...(item.relatedCandidateIndexes ?? []), ...candidateRefs])],
        sharedVisualSystemKey: item.sharedVisualSystemKey ?? null,
        sharedVisualSystemCandidateIndex: systemIndex ?? item.sharedVisualSystemCandidateIndex ?? null,
      };
    }),
    mergeSuggestions: (model.mergeSuggestions ?? []).map((item, i) => {
      const refIndex = item.candidateRef ? resolve(item.candidateRef, ["mergeSuggestions", i, "candidateRef"]) : null;
      if (refIndex !== null && item.candidateIndex != null && refIndex !== item.candidateIndex)
        invalid(["mergeSuggestions", i, "candidateRef"], "合并建议的引用相互冲突");
      return { candidateIndex: refIndex ?? item.candidateIndex ?? invalid(["mergeSuggestions", i, "candidateRef"], "合并建议缺少候选引用"),
        existingCanonicalKey: item.existingCanonicalKey, reason: item.reason };
    }),
    coverage: (model.coverage ?? []).map((item, i) => ({
      label: item.label, coverageType: item.coverageType, classification: item.classification,
      candidateIndexes: [...new Set([...(item.candidateIndexes ?? []), ...(item.candidateRefs ?? []).map((ref, j) => resolve(ref, ["coverage", i, "candidateRefs", j]))])],
      existingCanonicalKeys: item.existingCanonicalKeys ?? [], note: item.note ?? "",
    })),
  };
  return assetExtractionProposalSchema.parse(normalized);
}

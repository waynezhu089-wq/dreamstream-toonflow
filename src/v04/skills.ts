import { randomUUID } from "node:crypto";
import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { PilotError } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { safeStructuredStatus, structuredFailure, structuredRepairContext, structuredValidationSummary } from "./structuredOutputError";
import { assetExtractionModelSchema, normalizeAssetExtraction, semanticLabelDiagnostics } from "./assetExtractionOutput";

const id = z.number().int().positive();
const request = z.object({ projectId: id, scriptId: id, method: z.enum(["ASSET_EXTRACTION", "ASSET_PROMPTS", "STORYBOARD_BATCH"]) }).strict();
const outputSchemas = {
  ASSET_EXTRACTION: assetExtractionModelSchema,
  ASSET_PROMPTS: z.object({ prompts: z.array(z.object({ canonicalKey: z.string(), prompt: z.string().min(1).max(8000), reason: z.string().max(1000) }).strict()).max(100) }).strict(),
  STORYBOARD_BATCH: z.object({ shots: z.array(z.object({ duration: z.number().positive().max(600), prompt: z.string().min(1).max(20000), videoDesc: z.string().max(20000), productionMode: z.enum(["REAL_ASSET_DIRECT", "AI_TEXT_TO_IMAGE", "REAL_AI_COMPOSITE"]), primaryKey: z.string().nullable(), canonicalKeys: z.array(z.string()).max(50) }).strict()).min(1).max(100) }).strict(),
};
const instructions = {
  ASSET_EXTRACTION: "方法 v04.asset-extraction.v2：以已确认 Creative Truth（尤其 Treatment）为来源，按五个逻辑 pass 逐项检查：1 Entity 人物/生物/载具/道具/品牌；2 Environment 主/子/重复空间、环境锚点和时间氛围；3 Visual System 持续 FX、材质、能量、光与色彩；4 Continuity Relationship 共享视觉系统、变体、canonical 与 shot-local；5 Coverage Audit 列出 Treatment 每个重要视觉元素，包括尚未覆盖者，并给出分类。Treatment 非空时 coverage 不能是空数组。不要只提取主体，也不要凭空补 Treatment 没有的项目专属元素。核心人物、生物、载具、道具 importance=CORE，场景/FX/品牌不默认三视图。已有 canonical identity 不得重复创建；已存在的 Logo 只给 mergeSuggestions/reference usage。新候选彼此关联只用 relatedCandidateRefs/sharedVisualSystemRef；已存在身份只用 relatedExistingKeys/sharedVisualSystemKey/ownerKey/variantOf。真实 UI/Logo/产品文字必须 REAL_REQUIRED，不能 AI 重画。coverage 每项用 candidateRefs 或 existingCanonicalKeys 指明覆盖；未覆盖项留空并说明，shot-local/构图母题可分类记录而不伪造资产。prompt 可为空，详细 Prompt 留给 ASSET_PROMPTS。",
  ASSET_PROMPTS: "方法 v04.asset-prompt.v1：为每个已有 Canonical Asset 生成独立且一致的素材 Prompt 草案。维持 identityAnchors 和 mustPreserve，遵守 forbiddenChanges。真实 UI、Logo、文字不能由 AI 重画。只返回现有 canonicalKey。",
  STORYBOARD_BATCH: "方法 v04.storyboard-batch.v1：根据已确认 Creative 和 Asset Bible 提出约目标时长的分镜方案。引用只用给定 canonicalKey。真实 UI/Logo 必须 REAL_ASSET_DIRECT 或 REAL_AI_COMPOSITE，不要用 AI_TEXT_TO_IMAGE 伪造真实界面。此结果只是提案，不是生产数据库。",
} as const;

const creativeProposalRequest = z.object({ projectId: id, scriptId: id, target: z.enum(["brief", "treatment", "script"]), instruction: z.string().max(8000).default("") }).strict();
const creativeProposalOutput = z.object({ proposedText: z.string().min(1).max(30000), reason: z.string().max(1500), proposedTargetDuration: z.number().int().min(1).max(600).nullable() }).strict();
function requestsDurationChange(instruction: string) {
  if (/(?:不要|不需|无需|保持|别|勿).{0,12}(?:目标时长|片长|总时长|duration)|(?:目标时长|片长|总时长|duration).{0,8}(?:保持|不改|不变)/i.test(instruction)) return false;
  return /(?:目标时长|片长|总时长|duration).{0,16}(?:先按|按|改|调整|修改|设|定|变成)|(?:请|想|建议|希望).{0,16}(?:目标时长|片长|总时长|duration)|(?:延长|缩短).{0,24}\d{1,3}\s*(?:秒|s\b|seconds?)/i.test(instruction);
}
function logSkillFailure(data: z.infer<typeof request>, correlationId: string, errorCode: string, error: unknown, modelReference?: string, repairAttempt?: number) {
  const reference = modelReference && /^[A-Za-z0-9._:/-]{1,128}$/.test(modelReference) && !/(?:secret|token|key|authorization|sk-)/i.test(modelReference) ? modelReference : null;
  console.error("[V04 Skill][Failure]", {
    method: data.method, projectId: data.projectId, scriptId: data.scriptId,
    errorCode, errorName: error instanceof Error ? error.name : "Error",
    correlationId, modelReference: reference,
    providerId: reference?.includes(":") ? reference.split(":", 1)[0] : null,
    status: safeStructuredStatus(error), repairAttempt,
    validation: structuredValidationSummary(error),
    semanticLabels: data.method === "ASSET_EXTRACTION" ? semanticLabelDiagnostics(error) : [],
  });
}

export async function previewCreativeProposal(input: unknown) {
  const data = creativeProposalRequest.parse(input);
  let context: Awaited<ReturnType<typeof buildProjectAgentContext>>;
  try {
    context = await buildProjectAgentContext({ projectId: data.projectId, scriptId: data.scriptId, currentStage: "creative", currentRoute: "pilot/creative", selectedObject: null }, data.instruction);
  } catch (error) {
    if (error instanceof PilotError) throw error;
    console.error("[V04 Creative][ContextFailure]", { code: "PILOT_CREATIVE_CONTEXT_FAILED", projectId: data.projectId, errorName: error instanceof Error ? error.name : "Error" });
    throw new PilotError("PILOT_CREATIVE_CONTEXT_FAILED", "项目上下文读取失败，请稍后重试", 503);
  }
  const durationRequested = requestsDurationChange(data.instruction);
  const system = `${renderProjectAgentSystem(context)}\n只提出 ${data.target} 的完整候选正文；保持其他 Creative 字段不变。目标时长只以已确认 Creative Truth 的 targetDuration 为准，不从 Treatment 正文猜测。${durationRequested ? "用户明确要求调整目标时长；若建议新时长，proposedTargetDuration 必须是 1–600 的单个整数，仍须人工预览确认。" : "用户没有明确要求调整目标时长；proposedTargetDuration 必须为 null，即使 Treatment 正文提到其他时长。"}用户本轮 instruction 是生成要求，不能覆盖上述权威项目事实。缓存视觉观察仅描述可见内容，不能改变 Asset Bible 确认状态；没有缓存时不要猜测图片内容。Return one valid JSON object only: {"proposedText":"","reason":"","proposedTargetDuration":null}. No markdown. Never claim the proposal has been applied.`;
  let model: Awaited<ReturnType<typeof requireModel>>;
  try { model = await requireModel(data.projectId, "text"); }
  catch { throw new PilotError("PILOT_CREATIVE_MODEL_FAILED", "文本模型不可用，请检查模型配置", 502); }
  try {
    // The text model receives only text and confirmed reference metadata.
    // Recent chat images are never forwarded as raw multimodal input.
    const result = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({ system, messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ target: data.target, instruction: data.instruction }) }] }], output: Output.object({ schema: creativeProposalOutput }) });
    const candidate = creativeProposalOutput.parse(result.output);
    if (!durationRequested) candidate.proposedTargetDuration = null;
    return { target: data.target, sourceVersion: context.creative.version, candidate, applied: false };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const schemaFailure = structuredFailure(error);
    const code = schemaFailure ? "PILOT_CREATIVE_SCHEMA_FAILED" : "PILOT_CREATIVE_MODEL_FAILED";
    console.error("[V04 Creative][ProposalFailure]", { code, projectId: data.projectId, target: data.target, errorName: name });
    throw new PilotError(code, schemaFailure ? "文本模型已返回内容，但创意提案结构不符合要求，请重试" : "文本模型调用失败，请检查供应商配置后重试", 502);
  }
}
export async function previewSkill(input: unknown) {
  const data = request.parse(input);
  const correlationId = randomUUID();
  let context: Awaited<ReturnType<typeof buildProjectAgentContext>>;
  try {
    context = await buildProjectAgentContext({ projectId: data.projectId, scriptId: data.scriptId, currentStage: data.method === "STORYBOARD_BATCH" ? "storyboard" : "creative", currentRoute: "pilot/skills", selectedObject: null }, instructions[data.method]);
  } catch (error) {
    if (error instanceof PilotError) throw error;
    logSkillFailure(data, correlationId, "PILOT_SKILL_CONTEXT_FAILED", error);
    throw new PilotError("PILOT_SKILL_CONTEXT_FAILED", "项目上下文读取失败，请稍后重试", 503);
  }
  let session: Awaited<ReturnType<ReturnType<typeof u.Ai.Text>["trackedSession"]>>;
  try {
    const model = await requireModel(data.projectId, "text");
    session = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).trackedSession();
  } catch (error) {
    logSkillFailure(data, correlationId, "PILOT_SKILL_MODEL_FAILED", error);
    throw new PilotError("PILOT_SKILL_MODEL_FAILED", "文本模型调用失败，请检查供应商配置", 502);
  }
  const schema = outputSchemas[data.method];
  const skeleton = data.method === "ASSET_EXTRACTION" ? { candidates: [{ name: "", category: "CHAR", assetKind: "HUMAN_CHARACTER", importance: "CORE", description: "", sourcePolicy: "AI_ALLOWED", extractionPass: "ENTITY" }], coverage: [{ label: "", coverageType: "PERSON", classification: "CANONICAL_ASSET", candidateRefs: ["candidate name"] }] } :
    data.method === "ASSET_PROMPTS" ? { prompts: [{ canonicalKey: "", prompt: "", reason: "" }] } : { shots: [{ duration: 3, prompt: "", videoDesc: "", productionMode: "AI_TEXT_TO_IMAGE", primaryKey: null, canonicalKeys: [] }] };
  const system = `${renderProjectAgentSystem(context)}\n${instructions[data.method]}\n${data.method === "ASSET_EXTRACTION" ? "候选关系、合并建议和 coverage 用候选名称或唯一 localRef（relatedCandidateRefs / sharedVisualSystemRef / candidateRef / candidateRefs），不要维护数字下标。已有身份用真实 canonicalKey。只有真实存在的关系才输出可选字段；identityAnchors、mustPreserve、forbiddenChanges、prompt、ownerKey、variantOf 等无内容时可省略，服务器会补安全默认值。Coverage 必须如实列出未覆盖项。" : ""}\nReturn one valid JSON object only. Use this JSON structure: ${JSON.stringify(skeleton)}. No markdown or extra fields. Do not claim changes were applied.`;
  const user = JSON.stringify({ method: data.method });
  let output: any;
  let repairContext = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let candidate: unknown;
    try {
      // One pinned provider/model configuration for both structured attempts.
      const messages = [{ role: "user" as const, content: user }];
      if (attempt) messages.push({ role: "user", content: `The previous structured result failed validation. Repair format and field types only; do not reconsider creative decisions or add new assets. Return one complete JSON object matching ${JSON.stringify(skeleton)}. Previous result or SDK repair context: ${repairContext}` });
      const result = await session.invokeObject({ system, messages, schema: schema as any });
      candidate = result.object;
      output = data.method === "ASSET_EXTRACTION" ? normalizeAssetExtraction(candidate) : schema.parse(candidate);
      if (data.method === "ASSET_EXTRACTION" && context.creative.treatment.trim() && !output.coverage.length)
        throw new z.ZodError([{ code: "custom", path: ["coverage"], message: "已确认 Treatment 必须有覆盖审计" }]);
      if (data.method === "ASSET_EXTRACTION" && context.creative.treatment.trim()) {
        const accounted = new Set<number>([...output.coverage.flatMap((item: any) => item.candidateIndexes), ...output.mergeSuggestions.map((item: any) => item.candidateIndex)]);
        if (output.candidates.some((_: any, index: number) => !accounted.has(index)))
          throw new z.ZodError([{ code: "custom", path: ["coverage"], message: "每个候选必须进入覆盖审计或合并建议" }]);
      }
      break;
    } catch (error) {
      if (!structuredFailure(error)) {
        logSkillFailure(data, correlationId, "PILOT_SKILL_MODEL_FAILED", error, session.modelReference, attempt);
        throw new PilotError("PILOT_SKILL_MODEL_FAILED", "文本模型调用失败，请检查供应商配置", 502);
      }
      logSkillFailure(data, correlationId, "PILOT_SKILL_SCHEMA_FAILED", error, session.modelReference, attempt);
      if (attempt) throw new PilotError("PILOT_SKILL_SCHEMA_FAILED", "模型已返回内容，但提案结构不符合要求或输出不完整，请重试", 502);
      repairContext = structuredRepairContext(error, candidate);
    }
  }
  try {
    const keys = new Set(context.assetBibleIndex.map(a => a.canonicalKey));
    if (data.method === "ASSET_PROMPTS" && output.prompts.some((p: any) => !keys.has(p.canonicalKey))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 提案引用了不存在的素材身份", 422);
    if (data.method === "STORYBOARD_BATCH" && output.shots.some((s: any) => [...s.canonicalKeys, ...(s.primaryKey ? [s.primaryKey] : [])].some(k => !keys.has(k)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 分镜引用了不存在的素材身份", 422);
    if (data.method === "ASSET_EXTRACTION") {
      if (output.mergeSuggestions.some((s: any) => s.candidateIndex >= output.candidates.length || !keys.has(s.existingCanonicalKey))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 合并建议引用无效", 422);
      if (output.candidates.some((asset: any, index: number) => [asset.ownerKey, asset.variantOf, asset.sharedVisualSystemKey, ...asset.relatedExistingKeys].some(key => key && !keys.has(key)) || asset.relatedCandidateIndexes.some((i: number) => i >= output.candidates.length || i === index) || asset.sharedVisualSystemCandidateIndex !== null && (asset.sharedVisualSystemCandidateIndex >= output.candidates.length || asset.sharedVisualSystemCandidateIndex === index))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "候选关系只能引用当前项目身份或本次有效候选", 422);
      if (output.candidates.some((asset: any) => (["BRAND", "UI"].includes(asset.category) && asset.sourcePolicy !== "REAL_REQUIRED") ||
        (asset.sharedVisualSystemCandidateIndex !== null && !["FX", "MATERIAL_FX"].includes(output.candidates[asset.sharedVisualSystemCandidateIndex]?.category) && output.candidates[asset.sharedVisualSystemCandidateIndex]?.assetKind !== "MATERIAL_FX") ||
        (asset.sharedVisualSystemKey && !context.assetBibleIndex.some(existing => existing.canonicalKey === asset.sharedVisualSystemKey && (existing.category === "FX" || existing.assetKind === "MATERIAL_FX")))))
        throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "真实品牌与界面来源或共享视觉系统关系无效", 422);
      if (output.coverage.some((item: any) => item.candidateIndexes.some((i: number) => i >= output.candidates.length) || item.existingCanonicalKeys.some((key: string) => !keys.has(key)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "覆盖清单引用无效", 422);
      if (output.candidates.some((asset: any, index: number) => context.assetBibleIndex.some(existing => existing.category === asset.category && existing.name.trim().toLocaleLowerCase() === asset.name.trim().toLocaleLowerCase() && !output.mergeSuggestions.some((s: any) => s.candidateIndex === index && s.existingCanonicalKey === existing.canonicalKey)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "已有素材身份只能提出合并建议，不能作为新候选创建", 422);
    }
    return { method: data.method, skillId: `v04.${data.method.toLowerCase().replaceAll('_','-')}.${data.method === "ASSET_EXTRACTION" ? "v2" : "v1"}`, output, applied: false, sourceVersion: context.creative.version };
  } catch (error) {
    if (error instanceof PilotError) { logSkillFailure(data, correlationId, error.code, error, session.modelReference); throw error; }
    logSkillFailure(data, correlationId, "PILOT_SKILL_INTERNAL_FAILED", error, session.modelReference);
    throw new PilotError("PILOT_SKILL_INTERNAL_FAILED", "提案校验失败，请稍后重试", 500);
  }
}

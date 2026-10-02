import { randomUUID } from "node:crypto";
import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { PilotError } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { safeStructuredStatus, structuredFailure, structuredRepairContext } from "./structuredOutputError";

const id = z.number().int().positive();
const request = z.object({ projectId: id, scriptId: id, method: z.enum(["ASSET_EXTRACTION", "ASSET_PROMPTS", "STORYBOARD_BATCH"]) }).strict();
const candidate = z.object({ name: z.string().trim().min(1).max(256), category: z.enum(["CHAR", "ACC", "PROP", "PRODUCT", "LOC", "BRAND", "UI", "FX"]), description: z.string().max(4000), identityAnchors: z.array(z.string().max(300)).max(30), mustPreserve: z.array(z.string().max(300)).max(30), forbiddenChanges: z.array(z.string().max(300)).max(30), ownerKey: z.string().max(128).nullable(), variantOf: z.string().max(128).nullable(), sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]), prompt: z.string().max(8000) }).strict();
const outputSchemas = {
  ASSET_EXTRACTION: z.object({ candidates: z.array(candidate).max(80), mergeSuggestions: z.array(z.object({ candidateIndex: z.number().int().nonnegative(), existingCanonicalKey: z.string(), reason: z.string() }).strict()).max(80) }).strict(),
  ASSET_PROMPTS: z.object({ prompts: z.array(z.object({ canonicalKey: z.string(), prompt: z.string().min(1).max(8000), reason: z.string().max(1000) }).strict()).max(100) }).strict(),
  STORYBOARD_BATCH: z.object({ shots: z.array(z.object({ duration: z.number().positive().max(600), prompt: z.string().min(1).max(20000), videoDesc: z.string().max(20000), productionMode: z.enum(["REAL_ASSET_DIRECT", "AI_TEXT_TO_IMAGE", "REAL_AI_COMPOSITE"]), primaryKey: z.string().nullable(), canonicalKeys: z.array(z.string()).max(50) }).strict()).min(1).max(100) }).strict(),
};
const instructions = {
  ASSET_EXTRACTION: "方法 v04.asset-extraction.v1：从 Creative/Script、项目对话与已接受/否决决定识别持续存在的视觉实体。已有 canonical identity 不得重复创建；若发现已有 Logo 等身份，只在 mergeSuggestions 用当前真实 canonicalKey 提出合并建议，绝不自动合并。蓝色荧光梦物质若出现在当前创意中可作为 FX 候选；海盗船、潜水艇、飞马是否独立为资产，按其是否为持续视觉实体判断。真实 UI/Logo/产品文字必须 REAL_REQUIRED。ownerKey/variantOf 只能引用当前已存在的 canonicalKey，不能引用尚未分配 ID 的新候选。prompt 可为空，详细 Prompt 留给 ASSET_PROMPTS。",
  ASSET_PROMPTS: "方法 v04.asset-prompt.v1：为每个已有 Canonical Asset 生成独立且一致的素材 Prompt 草案。维持 identityAnchors 和 mustPreserve，遵守 forbiddenChanges。真实 UI、Logo、文字不能由 AI 重画。只返回现有 canonicalKey。",
  STORYBOARD_BATCH: "方法 v04.storyboard-batch.v1：根据已确认 Creative 和 Asset Bible 提出约目标时长的分镜方案。引用只用给定 canonicalKey。真实 UI/Logo 必须 REAL_ASSET_DIRECT 或 REAL_AI_COMPOSITE，不要用 AI_TEXT_TO_IMAGE 伪造真实界面。此结果只是提案，不是生产数据库。",
} as const;

const creativeProposalRequest = z.object({ projectId: id, scriptId: id, target: z.enum(["brief", "treatment", "script"]), instruction: z.string().max(8000).default("") }).strict();
const creativeProposalOutput = z.object({ proposedText: z.string().min(1).max(30000), reason: z.string().max(1500), proposedTargetDuration: z.number().int().min(1).max(600).nullable() }).strict();
function requestsDurationChange(instruction: string) {
  if (/(?:不要|不需|无需|保持|别|勿).{0,12}(?:目标时长|片长|总时长|duration)|(?:目标时长|片长|总时长|duration).{0,8}(?:保持|不改|不变)/i.test(instruction)) return false;
  return /(?:目标时长|片长|总时长|duration).{0,16}(?:先按|按|改|调整|修改|设|定|变成)|(?:请|想|建议|希望).{0,16}(?:目标时长|片长|总时长|duration)|(?:延长|缩短).{0,24}\d{1,3}\s*(?:秒|s\b|seconds?)/i.test(instruction);
}
function logSkillFailure(data: z.infer<typeof request>, correlationId: string, errorCode: string, error: unknown, modelReference?: string) {
  const reference = modelReference && /^[A-Za-z0-9._:/-]{1,128}$/.test(modelReference) && !/(?:secret|token|key|authorization|sk-)/i.test(modelReference) ? modelReference : null;
  console.error("[V04 Skill][Failure]", {
    method: data.method, projectId: data.projectId, scriptId: data.scriptId,
    errorCode, errorName: error instanceof Error ? error.name : "Error",
    correlationId, modelReference: reference,
    providerId: reference?.includes(":") ? reference.split(":", 1)[0] : null,
    status: safeStructuredStatus(error),
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
  const skeleton = data.method === "ASSET_EXTRACTION" ? { candidates: [{ name: "", category: "CHAR", description: "", identityAnchors: [], mustPreserve: [], forbiddenChanges: [], ownerKey: null, variantOf: null, sourcePolicy: "AI_ALLOWED", prompt: "" }], mergeSuggestions: [] } :
    data.method === "ASSET_PROMPTS" ? { prompts: [{ canonicalKey: "", prompt: "", reason: "" }] } : { shots: [{ duration: 3, prompt: "", videoDesc: "", productionMode: "AI_TEXT_TO_IMAGE", primaryKey: null, canonicalKeys: [] }] };
  const system = `${renderProjectAgentSystem(context)}\n${instructions[data.method]}\nReturn one valid JSON object only. Use this JSON structure: ${JSON.stringify(skeleton)}. No markdown or extra fields. Do not claim changes were applied.`;
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
      output = schema.parse(candidate);
      break;
    } catch (error) {
      if (!structuredFailure(error)) {
        logSkillFailure(data, correlationId, "PILOT_SKILL_MODEL_FAILED", error, session.modelReference);
        throw new PilotError("PILOT_SKILL_MODEL_FAILED", "文本模型调用失败，请检查供应商配置", 502);
      }
      logSkillFailure(data, correlationId, "PILOT_SKILL_SCHEMA_FAILED", error, session.modelReference);
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
      if (output.candidates.some((asset: any) => [asset.ownerKey, asset.variantOf].some(key => key && !keys.has(key)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "新候选的归属或变体只能引用现有身份", 422);
      if (output.candidates.some((asset: any, index: number) => context.assetBibleIndex.some(existing => existing.category === asset.category && existing.name.trim().toLocaleLowerCase() === asset.name.trim().toLocaleLowerCase() && !output.mergeSuggestions.some((s: any) => s.candidateIndex === index && s.existingCanonicalKey === existing.canonicalKey)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "已有素材身份只能提出合并建议，不能作为新候选创建", 422);
    }
    return { method: data.method, skillId: `v04.${data.method.toLowerCase().replaceAll('_','-')}.v1`, output, applied: false, sourceVersion: context.creative.version };
  } catch (error) {
    if (error instanceof PilotError) { logSkillFailure(data, correlationId, error.code, error, session.modelReference); throw error; }
    logSkillFailure(data, correlationId, "PILOT_SKILL_INTERNAL_FAILED", error, session.modelReference);
    throw new PilotError("PILOT_SKILL_INTERNAL_FAILED", "提案校验失败，请稍后重试", 500);
  }
}

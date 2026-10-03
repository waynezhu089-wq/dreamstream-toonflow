import { randomUUID } from "node:crypto";
import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { PilotError } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { safeStructuredStatus, structuredFailure, structuredRepairContext, structuredValidationSummary } from "./structuredOutputError";
import { assetExtractionModelSchema, normalizeAssetExtraction, semanticLabelDiagnostics } from "./assetExtractionOutput";
import { compileAssetExtractionSemantic } from "./assetExtractionSemantic";
import { compileAssetExtractionRelations } from "./assetExtractionRelations";
import { auditAssetSufficiency } from "./assetSufficiency";

const id = z.number().int().positive();
const request = z.object({ projectId: id, scriptId: id, method: z.enum(["ASSET_EXTRACTION", "ASSET_PROMPTS", "STORYBOARD_BATCH"]) }).strict();
const outputSchemas = {
  ASSET_EXTRACTION: assetExtractionModelSchema,
  ASSET_PROMPTS: z.object({ prompts: z.array(z.object({ canonicalKey: z.string(), prompt: z.string().min(1).max(8000), reason: z.string().max(1000) }).strict()).max(100) }).strict(),
  STORYBOARD_BATCH: z.object({ shots: z.array(z.object({ duration: z.number().positive().max(600), prompt: z.string().min(1).max(20000), videoDesc: z.string().max(20000), productionMode: z.enum(["REAL_ASSET_DIRECT", "AI_TEXT_TO_IMAGE", "REAL_AI_COMPOSITE"]), primaryKey: z.string().nullable(), canonicalKeys: z.array(z.string()).max(50) }).strict()).min(1).max(100) }).strict(),
};
const instructions = {
  ASSET_EXTRACTION: "方法 v04.asset-extraction.v2：从已确认 Treatment 做五轮思考：持续视觉实体；空间环境；共享视觉系统/材质；实体关系；逐个重要视觉节拍的覆盖审计。只描述人的创意判断，不翻译数据库 schema。visualElements 包含所有重要的角色、生物、载具、道具、环境、天体、共享视觉系统及品牌/UI；不要把纯构图目标误建成资产。不同的持续空间/时间环境应分别记录，不能把开场场景、受限内部空间与终场天空随意合并。type 从 HUMAN_CHARACTER、CREATURE、VEHICLE、PROP、ENVIRONMENT、CELESTIAL、MATERIAL_FX、BRAND_MARK、UI_REFERENCE 中选一个；type 表示实体本体，不是叙事用途：有生命的坐骑是 CREATURE，即使它承担交通作用，也不是 VEHICLE。relatedNames 只记录 Treatment 明示的持续身份/形态关系，不要把同框出现的人、品牌、环境全部互连；sharedVisualSystemName 只能使用本次元素名称。不要猜测新资产未来的 canonical key。对已有 Asset Bible 身份（尤其已存在的品牌标识）使用真实 existingCanonicalKey 提合并，不建立第二身份。真实 Logo/UI 不能 AI 重画。coverage 为每个重要画面元素或构图目标列 label、type、所关联 elementNames 或 existingCanonicalKeys；未覆盖项保留空关联和说明，不伪造覆盖。不要输出 category、assetKind、sourcePolicy、classification、数字索引或数据库 ID，服务器会编译这些字段。",
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
    context = await buildProjectAgentContext({ projectId: data.projectId, scriptId: data.scriptId, currentStage: data.method === "STORYBOARD_BATCH" ? "storyboard" : "creative", currentRoute: "pilot/skills", selectedObject: null }, data.method === "ASSET_EXTRACTION" ? "Treatment visual coverage" : instructions[data.method]);
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
  const skeleton = data.method === "ASSET_EXTRACTION" ? { visualElements: [{ name: "主体", type: "HUMAN_CHARACTER", description: "简短视觉描述" }], coverage: [{ label: "主体首次出现", type: "HUMAN_CHARACTER", elementNames: ["主体"] }] } :
    data.method === "ASSET_PROMPTS" ? { prompts: [{ canonicalKey: "", prompt: "", reason: "" }] } : { shots: [{ duration: 3, prompt: "", videoDesc: "", productionMode: "AI_TEXT_TO_IMAGE", primaryKey: null, canonicalKeys: [] }] };
  // Extraction has a narrow grounding boundary: operational policies, prior
  // conversations and Agent memories are not Treatment visual requirements.
  const extractionSystem = `你只审计下方已确认 Treatment 的视觉内容。项目规则、历史聊天、模型建议都不是视觉需求；Treatment 没有软件 UI 或产品界面，就不能凭来源规则虚构 UI 缺口。已有 Asset Bible 身份仅用于合并/引用，不能据此编造 Treatment 画面。\n已确认 Treatment: ${JSON.stringify(context.creative.treatment)}\n已有 ACTIVE 身份: ${JSON.stringify(context.assetBibleIndex.map(asset => ({ canonicalKey: asset.canonicalKey, name: asset.name, category: asset.category, assetKind: asset.assetKind })))}\n按视觉实体、环境、共享视觉系统、持续关系、画面覆盖逐项检查。Treatment 中重要且明显不同的空间环境即使尚无候选资产，也必须在 coverage 留下未绑定的 SCENE 行；同一主环境的局部变化可由一个 Master Environment 覆盖，不要机械增加身份。动作、镜头构图及瞬时效果只写入 coverage，不建独立 visualElement。visualElements 的 type 使用 HUMAN_CHARACTER/CREATURE/VEHICLE/PROP/ENVIRONMENT/CELESTIAL/MATERIAL_FX/BRAND_MARK/UI_REFERENCE；有生命的坐骑是 CREATURE。已有 canonical identity 不得重复创建；已存在品牌标识用 existingCanonicalKey 建议合并。不要生成数据库 key、category、assetKind、sourcePolicy 或数字索引。coverage 只能列 Treatment 真实出现的视觉对象和画面事件，必须用 elementNames 或 existingCanonicalKeys 指向生产归属；缺失时留空并说明，不能为了覆盖率伪造资产。JSON 只含 visualElements 与 coverage。`;
  const system = `${data.method === "ASSET_EXTRACTION" ? extractionSystem : `${renderProjectAgentSystem(context)}\n${instructions[data.method]}`}\n${data.method === "ASSET_EXTRACTION" ? "每个 visualElement 给 name/type/description，可选 core、realSourceRequired、existingCanonicalKey。关系判断留给下一次小范围调用，本次不要输出 relatedNames 或 sharedVisualSystemName。每个 coverage 给 label/type/elementNames/existingCanonicalKeys/note。名称引用须完全一致。" : ""}\nReturn one valid JSON object only. Use this JSON structure: ${JSON.stringify(skeleton)}. No markdown or extra fields. Do not claim changes were applied.`;
  const user = JSON.stringify({ method: data.method });
  let output: any;
  let repairContext = "";
  let repairAttempts = 0;
  let semanticExtraction = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) repairAttempts = 1;
    let candidate: unknown;
    try {
      // One pinned provider/model configuration for both structured attempts.
      const messages = [{ role: "user" as const, content: user }];
      if (attempt) messages.push({ role: "user", content: `The previous JSON result failed local validation. Repair references and format only; do not reconsider creative decisions or add new assets. Return one complete JSON object matching ${JSON.stringify(skeleton)}. Previous result or SDK repair context: ${repairContext}` });
      if (data.method === "ASSET_EXTRACTION") {
        // DeepSeek's chat JSON mode guarantees JSON syntax, not our full schema.
        // Do not hand the canonical Proposal schema to the provider/SDK.
        const result = await session.invoke({ system, messages, output: Output.json() });
        candidate = result.output;
        semanticExtraction = !!candidate && typeof candidate === "object" && "visualElements" in candidate;
        output = semanticExtraction ? compileAssetExtractionSemantic(candidate, context.assetBibleIndex)
          : normalizeAssetExtraction(candidate); // Accepted legacy DTOs remain locally validated.
      } else {
        const result = await session.invokeObject({ system, messages, schema: schema as any });
        candidate = result.object;
        output = schema.parse(candidate);
      }
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
  let relationStatus: "READY" | "NEEDS_REVIEW" = "READY";
  let relationIssue: { code: string; message: string } | null = null;
  if (data.method === "ASSET_EXTRACTION" && semanticExtraction && context.creative.treatment.trim() && output.candidates.length > 1) {
    // A second small model call decides only relationships between the already
    // compiled exact names. It cannot create entities, coverage or project truth.
    const relationSystem = "根据 Treatment 判断已列视觉元素之间的持续身份/形态关系。只返回 JSON：sharedSystems=[{systemName,memberNames}] 与 continuityGroups=[{memberNames}]。systemName 必须是 MATERIAL_FX 元素，memberNames 必须是同一物质/视觉系统的连续形态；continuityGroups 只列 Treatment 明示为同一身份的不同形态。不要把仅同框出现的元素连起来。必须使用给定的原样名称，不发明 key，不增删视觉元素。";
    const relationInput = JSON.stringify({ treatment: context.creative.treatment,
      visualElements: output.candidates.map((item: any) => ({ name: item.name, type: item.assetKind })) });
    let relationRepair = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let relationCandidate: unknown;
      try {
        const messages = [{ role: "user" as const, content: relationInput }];
        if (attempt) { repairAttempts++; messages.push({ role: "user", content: `Repair only JSON shape and exact element-name references. Do not change the creative interpretation. ${relationRepair}` }); }
        const result = await session.invoke({ system: relationSystem, messages, output: Output.json() });
        relationCandidate = result.output;
        output = compileAssetExtractionRelations(output, relationCandidate);
        break;
      } catch (error) {
        if (!structuredFailure(error)) {
          logSkillFailure(data, correlationId, "PILOT_RELATION_MODEL_FAILED", error, session.modelReference, attempt);
          relationStatus = "NEEDS_REVIEW";
          relationIssue = { code: "PILOT_RELATION_MODEL_FAILED", message: "关系分析未完成，请人工核对共享视觉系统和连续形态" };
          break;
        }
        logSkillFailure(data, correlationId, "PILOT_RELATION_SCHEMA_FAILED", error, session.modelReference, attempt);
        if (attempt) {
          relationStatus = "NEEDS_REVIEW";
          relationIssue = { code: "PILOT_RELATION_SCHEMA_FAILED", message: "关系分析未完成，请人工核对共享视觉系统和连续形态" };
          break;
        }
        relationRepair = structuredRepairContext(error, relationCandidate);
      }
    }
  }
  try {
    const keys = new Set(context.assetBibleIndex.map(a => a.canonicalKey));
    if (data.method === "ASSET_PROMPTS" && output.prompts.some((p: any) => !keys.has(p.canonicalKey))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 提案引用了不存在的素材身份", 422);
    if (data.method === "STORYBOARD_BATCH" && output.shots.some((s: any) => [...s.canonicalKeys, ...(s.primaryKey ? [s.primaryKey] : [])].some(k => !keys.has(k)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 分镜引用了不存在的素材身份", 422);
    if (data.method === "ASSET_EXTRACTION") {
      const referenceError = (reason: string, message: string): never => {
        console.error("[V04 Skill][ReferenceInvalid]", { method: data.method, projectId: data.projectId, scriptId: data.scriptId, correlationId, reason });
        throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", message, 422);
      };
      if (output.mergeSuggestions.some((s: any) => s.candidateIndex >= output.candidates.length || !keys.has(s.existingCanonicalKey))) referenceError("MERGE_TARGET", "AI 合并建议引用无效");
      if (output.candidates.some((asset: any) => [asset.ownerKey, asset.variantOf, asset.sharedVisualSystemKey, ...asset.relatedExistingKeys].some(key => key && !keys.has(key)))) referenceError("UNKNOWN_EXISTING_KEY", "候选关系只能引用当前项目身份或本次有效候选");
      if (output.candidates.some((asset: any, index: number) => asset.relatedCandidateIndexes.some((i: number) => i >= output.candidates.length || i === index))) referenceError("BAD_CANDIDATE_LINK", "候选关系只能引用当前项目身份或本次有效候选");
      if (output.candidates.some((asset: any, index: number) => asset.sharedVisualSystemCandidateIndex !== null && (asset.sharedVisualSystemCandidateIndex >= output.candidates.length || asset.sharedVisualSystemCandidateIndex === index))) referenceError("BAD_SHARED_SYSTEM_LINK", "候选关系只能引用当前项目身份或本次有效候选");
      if (output.candidates.some((asset: any) => (["BRAND", "UI"].includes(asset.category) && asset.sourcePolicy !== "REAL_REQUIRED") ||
        (asset.sharedVisualSystemCandidateIndex !== null && !["FX", "MATERIAL_FX"].includes(output.candidates[asset.sharedVisualSystemCandidateIndex]?.category) && output.candidates[asset.sharedVisualSystemCandidateIndex]?.assetKind !== "MATERIAL_FX") ||
        (asset.sharedVisualSystemKey && !context.assetBibleIndex.some(existing => existing.canonicalKey === asset.sharedVisualSystemKey && (existing.category === "FX" || existing.assetKind === "MATERIAL_FX")))))
        referenceError("SOURCE_OR_VISUAL_SYSTEM", "真实品牌与界面来源或共享视觉系统关系无效");
      if (output.coverage.some((item: any) => item.candidateIndexes.some((i: number) => i >= output.candidates.length) || item.existingCanonicalKeys.some((key: string) => !keys.has(key)))) referenceError("COVERAGE_REFERENCE", "覆盖清单引用无效");
      if (output.candidates.some((asset: any, index: number) => context.assetBibleIndex.some(existing => existing.category === asset.category && existing.name.trim().toLocaleLowerCase() === asset.name.trim().toLocaleLowerCase() && !output.mergeSuggestions.some((s: any) => s.candidateIndex === index && s.existingCanonicalKey === existing.canonicalKey)))) referenceError("DUPLICATE_IDENTITY", "已有素材身份只能提出合并建议，不能作为新候选创建");
    }
    let sufficiency: ReturnType<typeof auditAssetSufficiency> | null = null;
    if (data.method === "ASSET_EXTRACTION") {
      if (semanticExtraction && context.creative.treatment.trim()) {
        // The first pass cannot discover an omission it never listed. This
        // small, independent read-only check sees only Treatment and the
        // proposed ownership map; every new warning needs a Treatment quote.
        const auditSystem = "只根据已确认 Treatment 与候选清单审计视觉生产归属。只返回 JSON：environments=[{label,evidenceQuote,coveredByName,reason}]、missing=[{label,type,evidenceQuote,reason}]、unsupportedCoverageLabels=[]。先按叙事顺序列出 Treatment 中每个重要且视觉上不同的空间环境，包括最后一段空间；不要只列实体。coveredByName 只能使用给定的 ENVIRONMENT 候选/现有环境原样名称；若目的地空间与出发地显著不同，旧环境、人物、飞行生物或月亮本体不能冒充目的地背景，此时填 null。允许同一个 Master Environment 承担同一主空间的局部变化，不强制拆分岸边与海面。missing 只列环境以外尚无归属的重要持续视觉对象；镜头动作和瞬时效果不要求建资产。每个 evidenceQuote 必须是 Treatment 中连续出现的原文片段，不能编造。unsupportedCoverageLabels 只列 Coverage 中不来自 Treatment、仅由系统规则或外部假设推导出的未绑定项目。只提出审查提示，不增删候选或声称已 Apply。";
        const auditInput = JSON.stringify({ treatment: context.creative.treatment,
          candidates: output.candidates.map((item: any) => ({ name: item.name, kind: item.assetKind })),
          existing: context.assetBibleIndex.map(item => ({ key: item.canonicalKey, name: item.name, category: item.category })),
          coverage: output.coverage.map((item: any) => ({ label: item.label, classification: item.classification, candidateNames: item.candidateIndexes.map((index: number) => output.candidates[index].name), existingKeys: item.existingCanonicalKeys })) });
        try {
          const auditResult = await session.invoke({ system: auditSystem, messages: [{ role: "user", content: auditInput }], output: Output.json() });
          sufficiency = auditAssetSufficiency(output, context.creative.treatment, auditResult.output, context.assetBibleIndex);
        } catch (error) {
          logSkillFailure(data, correlationId, "PILOT_SUFFICIENCY_AUDIT_INCOMPLETE", error, session.modelReference);
        }
      }
      sufficiency ??= auditAssetSufficiency(output, context.creative.treatment, undefined, context.assetBibleIndex);
      output = sufficiency.proposal;
    }
    const { proposal: _proposal, ...review } = sufficiency ?? { proposal: null };
    return { method: data.method, skillId: `v04.${data.method.toLowerCase().replaceAll('_','-')}.${data.method === "ASSET_EXTRACTION" ? "v2" : "v1"}`, output, applied: false, sourceVersion: context.creative.version, repairAttempts,
      ...(data.method === "ASSET_EXTRACTION" ? { relationStatus, relationIssue } : {}),
      ...(sufficiency ? { sufficiency: review } : {}) };
  } catch (error) {
    if (error instanceof PilotError) { logSkillFailure(data, correlationId, error.code, error, session.modelReference); throw error; }
    logSkillFailure(data, correlationId, "PILOT_SKILL_INTERNAL_FAILED", error, session.modelReference);
    throw new PilotError("PILOT_SKILL_INTERNAL_FAILED", "提案校验失败，请稍后重试", 500);
  }
}

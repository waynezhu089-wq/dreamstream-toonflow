import { randomUUID } from "node:crypto";
import { z } from "zod";
import u from "@/utils";
import { ModelConfigError, requireModel } from "@/services/modelPreset";
import { PilotError, readPilot } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { agentActionRequest, finalizeAgentAction, prepareAgentAction, targetConfirmation } from "./agentActionProposal";
import { parseStudioTurnSemantic, StudioSemanticError, studioModeHint, studioTurnFormat } from "./studioTurnSemantic";

const contextSchema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
  currentStage: z.string().max(80), currentRoute: z.string().max(200),
  selectedObject: z.object({ type: z.enum(["PROJECT", "ASSET", "SHOT"]), key: z.string().max(128) }).nullable(),
}).strict();
export const studioTurnRequest = z.object({
  context: contextSchema, message: z.string().trim().min(1).max(8000),
  optionalDraft: agentActionRequest.shape.optionalDraft,
}).strict();
export class StudioTurnFailure extends PilotError {
  readonly terminal = true;
  readonly retryAllowed = true;
  readonly checkStatusUseful = false;
  userMessageId?: string;
  constructor(code: string, message: string, public stage: string, public correlationId: string, status = 502) {
    super(code, message, status);
  }
}

function studioFailure(ctx: z.infer<typeof contextSchema>, stage: string, error?: unknown, repairAttempt = 0): never {
  const correlationId = randomUUID();
  console.error("[V04 StudioTurn][Failure]", { correlationId, projectId: ctx.projectId,
    selectedTargetType: ctx.selectedObject?.type ?? null, selectedTargetKey: ctx.selectedObject?.key ?? null,
    stage, repairAttempt, errorName: error instanceof Error ? error.name : "Error",
    validationPaths: error instanceof StudioSemanticError ? error.paths : [] });
  const messages: Record<string, string> = {
    MODEL_UNAVAILABLE: "请先配置可用的文本模型。消息已保存，但本次回答失败。",
    PROVIDER_FAILED: "文本模型调用失败。消息已保存，但本次回答失败。",
    EMPTY_RESPONSE: "文本模型没有返回可用内容。消息已保存，但本次回答失败。",
    JSON_EXTRACTION_FAILED: "文本模型的回答格式无法解析。消息已保存，但本次回答失败。",
    SEMANTIC_NORMALIZATION_FAILED: "文本模型的回答模式无法识别。消息已保存，但本次回答失败。",
    STRICT_VALIDATION_FAILED: "文本模型的回答结构不完整。消息已保存，但本次回答失败。",
    ACTION_FINALIZATION_FAILED: "修改提案未能完成。消息已保存，但正式内容没有改变。",
  };
  throw new StudioTurnFailure(`PILOT_STUDIO_${stage}`, messages[stage] ?? "消息已保存，但本次回答失败。",
    stage, correlationId, stage === "STRICT_VALIDATION_FAILED" || stage === "SEMANTIC_NORMALIZATION_FAILED" ? 422 : 502);
}

export async function answerStudioTurn(input: unknown) {
  const data = studioTurnRequest.parse(input);
  const ctx = data.context;
  const state = await readPilot({ projectId: ctx.projectId, scriptId: ctx.scriptId });
  const selected = ctx.selectedObject;
  const actionData = agentActionRequest.parse({ projectId: ctx.projectId, scriptId: ctx.scriptId,
    instruction: data.message, scope: selected ? { type: selected.type, key: selected.key } : { type: "PROJECT" },
    ...(data.optionalDraft ? { optionalDraft: data.optionalDraft } : {}) });
  const prepared = prepareAgentAction(state, actionData);
  const agentContext = await buildProjectAgentContext(ctx, data.message);
  const source = "early" in prepared ? null : prepared.source;
  const system = `${renderProjectAgentSystem(agentContext)}\n你是同一个 Project Agent 的 Studio 对话模式。${studioTurnFormat}` +
    `mode 必须是 DISCUSS、PROPOSE_CHANGE 或 NEEDS_TARGET_CONFIRMATION；reply 是自然、简洁的中文回答。` +
    `疑问、解释、对比和建议用 DISCUSS；只有用户明确要求改变当前对象，才用 PROPOSE_CHANGE，并填写 summary、rationale、patch。` +
    `目标含糊或涉及素材身份的改名、归属、退休等身份级修改时用 NEEDS_TARGET_CONFIRMATION。` +
    `提案尚未应用，绝不可声称已经改动正式项目。` +
    ("early" in prepared ? "当前没有可直接修改的视觉规格或明确目标。不要虚构视觉规格。" : `\n${prepared.system}`);
  let model: Awaited<ReturnType<typeof requireModel>>;
  try { model = await requireModel(ctx.projectId, "text"); }
  catch (error) {
    if (error instanceof ModelConfigError) studioFailure(ctx, "MODEL_UNAVAILABLE", error);
    studioFailure(ctx, "PROVIDER_FAILED", error);
  }
  let session: Awaited<ReturnType<ReturnType<typeof u.Ai.Text>["trackedSession"]>>;
  try {
    session = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).trackedSession();
  } catch (error) { studioFailure(ctx, "PROVIDER_FAILED", error); }
  const invoke = async (systemText: string, userText: string, repairAttempt = 0) => {
    try { return (await session.invoke({ system: systemText,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }] })).text; }
    catch (error) { studioFailure(ctx, "PROVIDER_FAILED", error, repairAttempt); }
  };
  const raw = await invoke(system, JSON.stringify({ message: data.message, selectedObject: selected, source }));
  let turn: ReturnType<typeof parseStudioTurnSemantic>;
  try { turn = parseStudioTurnSemantic(raw); }
  catch (error) {
    if (!(error instanceof StudioSemanticError)) studioFailure(ctx, "STRICT_VALIDATION_FAILED", error);
    const originalMode = raw ? studioModeHint(raw) : null;
    if (!error.repairable || !raw?.trim() || !originalMode) studioFailure(ctx, error.stage, error);
    const repaired = await invoke(`Repair the format of the supplied Studio Turn only. ${studioTurnFormat}\n` +
      `Preserve the original meaning and mode. Do not invent project facts, visual design, shot content or action intent.`, raw, 1);
    try {
      turn = parseStudioTurnSemantic(repaired);
      if (turn.mode !== originalMode) throw new StudioSemanticError("STRICT_VALIDATION_FAILED", ["mode"]);
    }
    catch (repairError) {
      studioFailure(ctx, repairError instanceof StudioSemanticError ? repairError.stage : "STRICT_VALIDATION_FAILED", repairError, 1);
    }
  }
  if (turn.mode === "DISCUSS") return { mode: turn.mode, reply: turn.reply, applied: false };
  if (turn.mode === "NEEDS_TARGET_CONFIRMATION" || "early" in prepared) {
    const target = targetConfirmation(state);
    return { mode: "NEEDS_TARGET_CONFIRMATION", reply: "early" in prepared && prepared.early && "message" in prepared.early
      ? String(prepared.early.message) : turn.reply, candidates: target.candidates, applied: false };
  }
  // The existing action compiler validates permitted fields, ownership and the
  // Visual Spec preview. The model never writes authoritative state.
  let actionProposal: Awaited<ReturnType<typeof finalizeAgentAction>>;
  try { actionProposal = await finalizeAgentAction(actionData, prepared, {
    summary: turn.summary, rationale: turn.rationale, patch: turn.patch,
  }); }
  catch (error) { studioFailure(ctx, "ACTION_FINALIZATION_FAILED", error); }
  return { mode: "PROPOSE_CHANGE", reply: turn.reply, actionProposal, applied: false };
}

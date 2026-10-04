import { randomUUID } from "node:crypto";
import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { PilotError, readPilot } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { agentActionRequest, finalizeAgentAction, prepareAgentAction, targetConfirmation } from "./agentActionProposal";

const contextSchema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
  currentStage: z.string().max(80), currentRoute: z.string().max(200),
  selectedObject: z.object({ type: z.enum(["PROJECT", "ASSET", "SHOT"]), key: z.string().max(128) }).nullable(),
}).strict();
export const studioTurnRequest = z.object({
  context: contextSchema, message: z.string().trim().min(1).max(8000),
  optionalDraft: agentActionRequest.shape.optionalDraft,
}).strict();
const studioOutput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("DISCUSS"), reply: z.string().min(1).max(12000) }),
  z.object({ mode: z.literal("NEEDS_TARGET_CONFIRMATION"), reply: z.string().min(1).max(12000) }),
  z.object({ mode: z.literal("PROPOSE_CHANGE"), reply: z.string().min(1).max(12000),
    summary: z.string().min(1).max(500), rationale: z.string().max(1000), patch: z.record(z.string(), z.unknown()) }),
]);

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
  const system = `${renderProjectAgentSystem(agentContext)}\n你是同一个 Project Agent 的 Studio 对话模式。只返回一个 JSON 对象。` +
    `mode 必须是 DISCUSS、PROPOSE_CHANGE 或 NEEDS_TARGET_CONFIRMATION；reply 是自然、简洁的中文回答。` +
    `疑问、解释、对比和建议用 DISCUSS；只有用户明确要求改变当前对象，才用 PROPOSE_CHANGE，并填写 summary、rationale、patch。` +
    `目标含糊或涉及素材身份的改名、归属、退休等身份级修改时用 NEEDS_TARGET_CONFIRMATION。` +
    `提案尚未应用，绝不可声称已经改动正式项目。` +
    ("early" in prepared ? "当前没有可直接修改的视觉规格或明确目标。不要虚构视觉规格。" : `\n${prepared.system}`);
  let output: unknown;
  try {
    const model = await requireModel(ctx.projectId, "text");
    const response = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({ system,
      messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ message: data.message, selectedObject: selected, source }) }] }],
      output: Output.json() });
    output = response.output;
  } catch (error) {
    console.error("[V04 StudioTurn][ModelFailure]", { correlationId: randomUUID(), projectId: ctx.projectId,
      errorName: error instanceof Error ? error.name : "Error" });
    throw new PilotError("PILOT_STUDIO_MODEL_FAILED", "Project Agent 暂时无法回答，请检查文本模型", 502);
  }
  const parsed = studioOutput.safeParse(output);
  if (!parsed.success) throw new PilotError("PILOT_STUDIO_SCHEMA_FAILED", "Project Agent 的回答结构不完整，请重试", 422);
  const turn = parsed.data;
  if (turn.mode === "DISCUSS") return { mode: turn.mode, reply: turn.reply, applied: false };
  if (turn.mode === "NEEDS_TARGET_CONFIRMATION" || "early" in prepared) {
    const target = targetConfirmation(state);
    return { mode: "NEEDS_TARGET_CONFIRMATION", reply: "early" in prepared && prepared.early && "message" in prepared.early
      ? String(prepared.early.message) : turn.reply, candidates: target.candidates, applied: false };
  }
  // The existing action compiler validates permitted fields, ownership and the
  // Visual Spec preview. The model never writes authoritative state.
  const actionProposal = await finalizeAgentAction(actionData, prepared, {
    summary: turn.summary, rationale: turn.rationale, patch: turn.patch,
  });
  return { mode: "PROPOSE_CHANGE", reply: turn.reply, actionProposal, applied: false };
}

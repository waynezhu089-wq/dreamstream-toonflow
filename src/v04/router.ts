import express from "express";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { db } from "@/utils/db";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import Memory from "@/utils/agent/memory";
import { getEmbedding } from "@/utils/agent/embedding";
import { PilotError, applyAssets, applyCreative, createPilotProject, decide, listPilotProjects, previewAssets, previewCreative, proposeDecision, readPilot, resolveAssets } from "./service";
import { previewSkill, previewCreativeProposal } from "./skills";
import { applyAttachmentPromotion, attachmentsForMessage, getAgentAttachmentBytes, imageParts, previewAttachmentPromotion, uploadAgentImage } from "./agentAttachments";

const router = express.Router();
const id = z.number().int().positive();
const context = z.object({ projectId: id, scriptId: id.nullable(), currentStage: z.string().max(80), currentRoute: z.string().max(200), selectedObject: z.object({ type: z.enum(["ASSET", "SHOT", "PROJECT"]), key: z.string().max(128) }).nullable() }).strict();
const agentInput = z.object({ context, message: z.string().trim().max(8000), attachmentIds: z.array(z.string().uuid()).max(4).default([]) }).strict().refine(value => value.message.length > 0 || value.attachmentIds.length > 0, "消息或图片不能为空");
const memoryKey = (projectId: number) => `project:${projectId}:projectAgent`;
const missingLocalEmbedding = (error: unknown) => error instanceof Error && error.message.includes("Embedding 模型文件不存在");

router.use(async (req, res, next) => {
  const actorUserId = Number((req as any).user?.id);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) return res.status(401).json({ code: "PILOT_AUTH_REQUIRED", message: "需要登录" });
  const projectId = Number(req.body?.projectId ?? req.body?.context?.projectId);
  if (Number.isSafeInteger(projectId) && projectId > 0) {
    try {
      const project = await db("o_project").where({ id: projectId }).first();
      if (!project || Number(project.userId) !== actorUserId) return res.status(403).json({ code: "PILOT_FORBIDDEN", message: "无权访问这个项目" });
    } catch (error) { return next(error); }
  }
  next();
});

function endpoint(route: string, run: (body: any, req: express.Request) => Promise<unknown>) {
  router.post(route, async (req, res) => {
    try { res.json({ code: 200, data: await run(req.body, req), message: "成功" }); }
    catch (e: any) {
      const status = e instanceof ZodError ? 400 : e instanceof PilotError ? e.status : e?.status ?? 500;
      const code = e instanceof ZodError ? "PILOT_INPUT_INVALID" : e?.code ?? "PILOT_FAILED";
      if (status >= 500) console.error("[V04 Pilot]", e);
      res.status(status).json({ code, message: status >= 500 ? "操作失败，请查看后端日志" : e.message });
    }
  });
}
endpoint("/projects", async (_body, req) => listPilotProjects(Number((req as any).user.id)));
endpoint("/project/create", (body, req) => createPilotProject(body, Number((req as any).user.id)));
endpoint("/project/read", input => readPilot(input));
endpoint("/creative/preview", previewCreative);
endpoint("/creative/apply", applyCreative);
endpoint("/assets/preview", previewAssets);
endpoint("/assets/apply", applyAssets);
endpoint("/assets/resolve", resolveAssets);
endpoint("/skills/preview", previewSkill);
endpoint("/agent/creative-proposal", previewCreativeProposal);
endpoint("/agent/image/upload", uploadAgentImage);
endpoint("/agent/reference/preview", previewAttachmentPromotion);
endpoint("/agent/reference/apply", applyAttachmentPromotion);
endpoint("/decision/propose", proposeDecision);
endpoint("/decision/decide", decide);
endpoint("/agent/history", async input => {
  const { projectId } = z.object({ projectId: id }).parse(input);
  await readPilot({ projectId, scriptId: Number(input.scriptId) }, true);
  const rows = await db("memories").where({ isolationKey: memoryKey(projectId), type: "message" }).orderBy("createTime", "asc").limit(300);
  const attachments = rows.length ? await db("o_v04AgentAttachment").where({ projectId }).whereIn("messageId", rows.map(r => r.id)) : [];
  const references = await db("o_v04AgentReference").where({ projectId }).orderBy("createdAt", "asc").limit(300);
  return { isolationKey: memoryKey(projectId), messages: rows.map(r => ({ id: r.id, role: r.role, content: r.content, createTime: r.createTime, attachments: attachments.filter(a => a.messageId === r.id).map(a => ({ id: a.id, name: a.originalName, mimeType: a.mimeType, bytes: a.bytes, purpose: a.purpose, context: JSON.parse(a.contextJson), references: references.filter(ref => ref.attachmentId === a.id).map(ref => ({ id: ref.id, targetType: ref.targetType, targetKey: ref.targetKey, scriptId: ref.scriptId, assetId: ref.assetId })) })) })) };
});
router.get("/agent/image/:projectId/:attachmentId", async (req, res) => {
  try {
    const projectId = id.parse(Number(req.params.projectId));
    const owner = await db("o_project").where({ id: projectId, userId: Number((req as any).user?.id) }).first();
    if (!owner) return res.status(403).json({ code: "PILOT_FORBIDDEN" });
    const { row, bytes } = await getAgentAttachmentBytes(projectId, req.params.attachmentId);
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(bytes);
  } catch (error: any) { res.status(error?.status ?? 400).json({ code: error?.code ?? "PILOT_ATTACHMENT_INVALID" }); }
});
endpoint("/agent/chat", async input => {
  const { context: ctx, message, attachmentIds } = agentInput.parse(input);
  if (ctx.scriptId == null) throw new PilotError("PILOT_UNIT_REQUIRED", "请选择制作单元");
  const state = await readPilot({ projectId: ctx.projectId, scriptId: ctx.scriptId }, true);
  // Point-of-use. A missing model is reported before writing a misleading
  // assistant reply or calling a provider. No paid provider is invoked by setup.
  const model = await requireModel(ctx.projectId, "text");
  const key = memoryKey(ctx.projectId);
  const attachments = await attachmentsForMessage(ctx.projectId, attachmentIds);
  const recent = await db("memories").where({ isolationKey: key, type: "message" }).orderBy("createTime", "desc").limit(20);
  let relevantHistory: unknown[] = [];
  let rollingSummaries: unknown[] = [];
  if (message) {
    try {
      const remembered = await new Memory("projectAgent", key).get(message);
      relevantHistory = remembered.rag;
      rollingSummaries = remembered.summaries;
    } catch (error) {
      // A fresh disposable pilot may not have the local ONNX model. Its raw
      // conversation and structured decisions remain usable; never invent RAG.
      if (!missingLocalEmbedding(error)) throw error;
    }
  }
  const decisionRows = state.decisions.filter(d => d.status === "ACCEPTED" || d.status === "REJECTED");
  const selectedAsset = ctx.selectedObject?.type === "ASSET" ? state.assets.find(a => a.canonicalKey === ctx.selectedObject?.key) : null;
  const selectedShotIndex = ctx.selectedObject?.type === "SHOT" ? state.storyboards.findIndex(shot => String(shot.id) === ctx.selectedObject?.key) : -1;
  const selectedShotAndNeighbors = selectedShotIndex < 0 ? [] : state.storyboards.slice(Math.max(0, selectedShotIndex - 1), selectedShotIndex + 2);
  const system = [
    "你是同一个项目持续存在的 Project Agent。你可以建议，但不能声称已修改创意、资产、分镜或生产事实。修改须由用户预览并确认。",
    "聊天图片仅是 CONVERSATIONAL_REFERENCE。分析、比较、提取候选及 Prompt 建议可以使用图片，但不可把它当作已确认品牌/UI真实素材或自动写入 Asset Bible、素材清单、镜头。图片提升必须走单独的预览与人工确认。",
    "尊重已接受及否决决定；否决方向不要再次推荐。事实以提供的权威状态为准，摘要不是生产真相。",
    `项目: ${state.project.name}; 项目ID: ${ctx.projectId}; 当前制作单元: ${ctx.scriptId}`,
    `当前页面: ${ctx.currentRoute}; 工序: ${ctx.currentStage}; 当前选择: ${JSON.stringify(ctx.selectedObject)}`,
    `创意: ${JSON.stringify({ brief: state.creative.brief, treatment: state.creative.treatment, script: state.creative.script })}`,
    `项目决定: ${JSON.stringify(decisionRows.map(d => ({ status: d.status, content: d.content, subjectKey: d.subjectKey })))}`,
    `已选资产: ${JSON.stringify(selectedAsset)}`,
    `已选镜头与前后镜头: ${JSON.stringify(selectedShotAndNeighbors)}`,
    `最近对话: ${JSON.stringify(recent.reverse().map(r => ({ role: r.role, content: r.content })))}`,
    `相关历史: ${JSON.stringify(relevantHistory)}`,
    `历史摘要（非生产真相）: ${JSON.stringify(rollingSummaries)}`,
  ].join("\n");
  const userMessageId = randomUUID();
  const now = Date.now();
  let userEmbedding: number[] | null = null;
  if (message) {
    try { userEmbedding = await getEmbedding(message); }
    catch (error) { if (!missingLocalEmbedding(error)) throw error; }
  }
  await db.transaction(async trx => {
    const changed = attachmentIds.length ? await trx("o_v04AgentAttachment").where({ projectId: ctx.projectId, messageId: null }).whereIn("id", attachmentIds).update({ messageId: userMessageId, contextJson: JSON.stringify(ctx) }) : 0;
    if (changed !== attachmentIds.length) throw new PilotError("PILOT_ATTACHMENT_INVALID", "图片已在其他消息中使用", 409);
    await trx("memories").insert({ id: userMessageId, isolationKey: key, type: "message", role: "user", content: message || "[图片参考]", embedding: userEmbedding ? JSON.stringify(userEmbedding) : null, summarized: 0, createTime: now });
  });
  let result: { text: string };
  try {
    const parts = attachmentIds.length ? [{ type: "text" as const, text: message || "请分析这些图片。" }, ...await imageParts(attachments)] : message;
    result = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({ system, messages: [{ role: "user", content: parts }] });
  } catch (error) {
    if (attachmentIds.length) throw new PilotError("PILOT_IMAGE_MODEL_UNSUPPORTED", "图片已保存到对话，但当前文本模型未能处理图片；请配置支持图片输入的模型", 409);
    throw new PilotError("PILOT_AGENT_MODEL_FAILED", "消息已保存到对话，但模型未能回复；请检查文本模型配置", 502);
  }
  let embedding: number[] | null = null;
  try { embedding = await getEmbedding(result.text); }
  catch (error) { if (!missingLocalEmbedding(error)) throw error; }
  await db("memories").insert({ id: randomUUID(), isolationKey: key, type: "message", role: "assistant", content: result.text, embedding: embedding ? JSON.stringify(embedding) : null, summarized: 0, createTime: now + 1 });
  return { isolationKey: key, reply: result.text, applied: false, userMessageId };
});

export default router;

import {proposeDirector,previewDirector,confirmDirector,readDirector,directorHistory,rejectDirector} from "./directorBible";
import {directorDryRun} from './directorDryRun';
import {compileDirectorAB,readDirectorAB,renderDirectorAB,evaluateDirectorAB,directorABArtifact} from './directorAssetAB';
import {inspectOperations,recentExecutions,executionDetail,workflowExample,previewRouting,applyRouting} from './operations';
import {reconcileAutoAssets,autoAssetCoverage} from './autoAsset';
import {wakeDraftWorker} from './studioDraftImage';
import {listImageBaselines,previewImageBaseline,confirmImageBaseline} from './assetImageBaseline';
import { listAssetImageCandidates, previewAssetImageCandidate, acceptAssetImageCandidate, rejectAssetImageCandidate } from "./assetImageEdit";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { db } from "@/utils/db";
import { ModelConfigError, requireModel } from "@/services/modelPreset";
import { getEmbedding } from "@/utils/agent/embedding";
import { PilotError, applyAssets, applyCreative, createPilotProject, decide, listPilotProjects, planOptionalTurnaround, previewAssets, previewCreative, proposeDecision, readPilot, resolveAssets } from "./service";
import { previewSkill, previewCreativeProposal } from "./skills";
import { applyAttachmentPromotion, attachmentsForMessage, getAgentAttachmentBytes, previewAttachmentPromotion, uploadAgentImage } from "./agentAttachments";
import { answerProjectAgent } from "./agentOrchestrator";
import { proposeAgentAction } from "./agentActionProposal";
import { answerStudioTurn, StudioTurnFailure, studioTurnRequest } from "./studioTurn";
import { buildProjectAgentContext, projectAgentMemoryKey, renderProjectAgentSystem } from "./agentContext";
import { applyVisualSpec, compileStudioDraftPrompts, previewVisualSpec, proposeVisualSpecs, rebuildVisualPrompt, setLibraryBinding } from "./visualSpec";
import { configureDraftExecutor, enqueueDraftImage, getDraftArtifact, listDraftJobs, readDraftExecutor, testDraftExecutor } from "./studioDraftImage";
import { DraftComfyError } from "./comfyDraftClient";

const router = express.Router();
const id = z.number().int().positive();
const context = z.object({ projectId: id, scriptId: id.nullable(), currentStage: z.string().max(80), currentRoute: z.string().max(200), selectedObject: z.object({ type: z.enum(["ASSET", "SHOT", "PROJECT"]), key: z.string().max(128) }).nullable() }).strict();
const agentInput = z.object({ context, message: z.string().trim().max(8000), attachmentIds: z.array(z.string().uuid()).max(4).default([]) }).strict().refine(value => value.message.length > 0 || value.attachmentIds.length > 0, "消息或图片不能为空");
const memoryKey = projectAgentMemoryKey;
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
      const status = e instanceof ZodError ? 400 : e instanceof PilotError ? e.status : e instanceof DraftComfyError ? 409 : 500;
      const code = e instanceof ZodError ? "PILOT_INPUT_INVALID" : e instanceof PilotError || e instanceof DraftComfyError ? e.code : "PILOT_FAILED";
      if (status >= 500 && !(e instanceof PilotError)) console.error("[V04 Pilot][InternalFailure]", { code, errorName: e?.name ?? "Error" });
      res.status(status).json({ code, message: e instanceof PilotError || e instanceof DraftComfyError ? e.message : e instanceof ZodError ? "请求参数无效" : "操作失败，请查看后端日志",
        ...(e instanceof StudioTurnFailure ? { userMessageId: e.userMessageId, terminal: e.terminal,
          retryAllowed: e.retryAllowed, checkStatusUseful: e.checkStatusUseful, correlationId: e.correlationId } : {}) });
    }
  });
}
endpoint("/projects", async (_body, req) => listPilotProjects(Number((req as any).user.id)));
endpoint('/operations/status',inspectOperations);
endpoint('/studio/auto-assets/reconcile',async body=>{const result=await reconcileAutoAssets(body);wakeDraftWorker();return result;});
endpoint('/studio/auto-assets/coverage',autoAssetCoverage);
endpoint('/operations/executions',recentExecutions);
endpoint('/operations/execution',executionDetail);
endpoint('/operations/workflow/example',async input=>workflowExample(input));
endpoint('/operations/routing/preview',input=>previewRouting(input));
endpoint('/operations/routing/apply',(input,req)=>applyRouting(input,Number((req as any).user.id)));
endpoint("/project/create", (body, req) => createPilotProject(body, Number((req as any).user.id)));
endpoint("/project/read", input => readPilot(input));
endpoint("/director/dry-run",directorDryRun);
for(const [path,handler] of Object.entries({compile:compileDirectorAB,current:readDirectorAB,render:renderDirectorAB,evaluate:evaluateDirectorAB}))
  endpoint('/director/asset-ab/'+path,(input,req)=>handler(input,Number((req as any).user.id)));
router.post('/director/asset-ab/artifact',async(req,res)=>{
  try{const image=await directorABArtifact(req.body,Number((req as any).user.id));res.setHeader('Content-Type',image.mimeType);res.setHeader('Cache-Control','private, max-age=60');res.send(image.bytes);}
  catch(e){res.status(e instanceof PilotError?e.status:404).json({code:'DIRECTOR_AB_ARTIFACT_MISSING',message:'实验图片不可用'});}
});
for(const [path,handler] of Object.entries({propose:proposeDirector,preview:previewDirector,confirm:confirmDirector,current:readDirector,history:directorHistory,reject:rejectDirector})) endpoint("/director/"+path,(input,req)=>handler(input,Number((req as any).user.id)));
endpoint("/creative/preview", previewCreative);
endpoint("/creative/apply", applyCreative);
endpoint("/assets/preview", previewAssets);
endpoint("/assets/apply", applyAssets);
endpoint("/assets/turnaround/plan", planOptionalTurnaround);
endpoint("/assets/resolve", resolveAssets);
endpoint("/visual-spec/propose", proposeVisualSpecs);
endpoint("/visual-spec/draft-prompts", compileStudioDraftPrompts);
endpoint("/studio/executor/comfy/test", testDraftExecutor);
endpoint("/studio/executor/comfy/configure", configureDraftExecutor);
endpoint("/studio/executor/comfy/current", readDraftExecutor);
endpoint("/studio/draft-image/enqueue", enqueueDraftImage);
endpoint('/studio/image-baseline/current', listImageBaselines);
endpoint('/studio/image-baseline/preview', previewImageBaseline);
endpoint('/studio/image-baseline/confirm', confirmImageBaseline);
endpoint("/studio/image-edit/candidates", listAssetImageCandidates);
endpoint("/studio/image-edit/preview", previewAssetImageCandidate);
endpoint("/studio/image-edit/accept", acceptAssetImageCandidate);
endpoint("/studio/image-edit/reject", rejectAssetImageCandidate);
endpoint("/studio/draft-image/jobs", listDraftJobs);
router.get("/studio/artifact/:projectId/:artifactId", async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const actorUserId = Number((req as any).user?.id);
    if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(actorUserId)) return res.sendStatus(400);
    const project = await db("o_project").where({ id: projectId, userId: actorUserId }).first();
    if (!project) return res.sendStatus(403);
    const artifact = await getDraftArtifact(projectId, String(req.params.artifactId));
    res.setHeader("Content-Type", artifact.mimeType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(artifact.bytes);
  } catch (error) { res.status(error instanceof PilotError ? error.status : 404).json({ code: "ARTIFACT_MISSING", message: "草图不可用" }); }
});
endpoint("/visual-spec/preview", previewVisualSpec);
endpoint("/visual-spec/apply", applyVisualSpec);
endpoint("/visual-spec/prompt/rebuild", rebuildVisualPrompt);
endpoint("/assets/library-binding/set", setLibraryBinding);
endpoint("/skills/preview", previewSkill);
endpoint("/agent/creative-proposal", previewCreativeProposal);
endpoint("/agent/action-proposal", proposeAgentAction);
// A stable assistant identity is a final duplicate-write fence for retries,
// without introducing another task or lifecycle table.
function studioAssistantId(userMessageId: string) {
  const hash = createHash("sha256").update(`v04-studio-assistant:${userMessageId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
async function completeStudioTurn(input: z.infer<typeof studioTurnRequest>, userMessageId: string, actorUserId: number) {
  let result: Awaited<ReturnType<typeof answerStudioTurn>>;
  try { result = await answerStudioTurn(input, userMessageId, actorUserId); }
  catch (error) {
    if (error instanceof StudioTurnFailure) { error.userMessageId = userMessageId; throw error; }
    const correlationId = randomUUID();
    console.error("[V04 StudioTurn][Failure]", { correlationId, projectId: input.context.projectId,
      selectedTargetType: input.context.selectedObject?.type ?? null,
      selectedTargetKey: input.context.selectedObject?.key ?? null,
      stage: "PREPARATION_FAILED", errorName: error instanceof Error ? error.name : "Error" });
    const failure = new StudioTurnFailure("PILOT_STUDIO_PREPARATION_FAILED",
      "消息已保存，但 Project Agent 本次回答失败。", "PREPARATION_FAILED", correlationId);
    failure.userMessageId = userMessageId;
    throw failure;
  }
  const assistantMessageId = studioAssistantId(userMessageId);
  await db("memories").insert({ id: assistantMessageId, isolationKey: memoryKey(input.context.projectId), type: "message",
    role: "assistant", content: result.reply, embedding: null, summarized: 0, createTime: Date.now() });
  return { ...result, isolationKey: memoryKey(input.context.projectId), userMessageId, assistantMessageId };
}

endpoint("/agent/studio-turn", async (input,req) => {
  const data = studioTurnRequest.parse(input);
  await readPilot({ projectId: data.context.projectId, scriptId: data.context.scriptId });
  const attachments = await attachmentsForMessage(data.context.projectId, data.attachmentIds);
  if(attachments.some(a=>a.scriptId!==data.context.scriptId))throw new PilotError('PILOT_ATTACHMENT_INVALID','参考图片不属于当前制作单元',409);
  const key = memoryKey(data.context.projectId);
  const userMessageId = randomUUID();
  let embedding: number[] | null = null;
  try { embedding = await getEmbedding(data.message); }
  catch (error) { if (!missingLocalEmbedding(error)) throw error; }
  await db.transaction(async trx => {
    const changed = attachments.length ? await trx("o_v04AgentAttachment")
      .where({projectId:data.context.projectId,scriptId:data.context.scriptId,messageId:null}).whereIn("id",attachments.map(a=>a.id))
      .update({messageId:userMessageId,scriptId:data.context.scriptId,contextJson:JSON.stringify(data.context)}) : 0;
    if(changed!==attachments.length)throw new PilotError("PILOT_ATTACHMENT_INVALID","图片已在其他消息中使用",409);
    await trx("memories").insert({ id: userMessageId, isolationKey: key, type: "message", role: "user", content: data.message,
      embedding: embedding ? JSON.stringify(embedding) : null, summarized: 0, createTime: Date.now() });
  });
  return completeStudioTurn(data, userMessageId, Number((req as any).user.id));
});
const studioRetries = new Set<string>();
endpoint("/agent/studio-turn/retry", async (input,req) => {
  const data = studioTurnRequest.omit({ message: true }).extend({ userMessageId: z.string().uuid() }).parse(input);
  await readPilot({ projectId: data.context.projectId, scriptId: data.context.scriptId });
  const key = memoryKey(data.context.projectId);
  const user = await db("memories").where({ id: data.userMessageId, isolationKey: key, type: "message", role: "user" })
    .select("id", "content", "createTime", db.raw("rowid as sqliteRowId")).first();
  if (!user) throw new PilotError("PILOT_STUDIO_MESSAGE_NOT_FOUND", "原消息不存在于当前项目", 404);
  if(data.attachmentIds.length){const refs=await db("o_v04AgentAttachment").where({projectId:data.context.projectId,scriptId:data.context.scriptId,messageId:user.id}).whereIn("id",data.attachmentIds);if(refs.length!==data.attachmentIds.length)throw new PilotError("PILOT_ATTACHMENT_INVALID","参考图不属于原消息",409);}
  const existing = await db("memories").where({ id: studioAssistantId(user.id), isolationKey: key, role: "assistant" }).first();
  const next = await db("memories").where({ isolationKey: key, type: "message" })
    .whereRaw("rowid > ?", [user.sqliteRowId]).orderByRaw("rowid asc").first();
  if (existing || next?.role === "assistant")
    throw new PilotError("PILOT_STUDIO_ALREADY_ANSWERED", "这条消息已有回复，请刷新对话", 409);
  if (studioRetries.has(user.id)) throw new PilotError("PILOT_STUDIO_RETRY_IN_PROGRESS", "这条消息正在重试，请稍后查看对话", 409);
  studioRetries.add(user.id);
  try { return await completeStudioTurn({ context: data.context, message: user.content, attachmentIds:data.attachmentIds, ...(data.parentCandidateId?{parentCandidateId:data.parentCandidateId}:{}),
    ...(data.optionalDraft ? { optionalDraft: data.optionalDraft } : {}) }, user.id, Number((req as any).user.id)); }
  catch (error: any) {
    if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error?.code === "SQLITE_CONSTRAINT_UNIQUE")
      throw new PilotError("PILOT_STUDIO_ALREADY_ANSWERED", "这条消息已有回复，请刷新对话", 409);
    throw error;
  } finally { studioRetries.delete(user.id); }
});
endpoint("/agent/image/upload", uploadAgentImage);
endpoint("/agent/reference/preview", previewAttachmentPromotion);
endpoint("/agent/reference/apply", applyAttachmentPromotion);
endpoint("/decision/propose", proposeDecision);
endpoint("/decision/decide", decide);
endpoint("/agent/history", async input => {
  const { projectId } = z.object({ projectId: id }).parse(input);
  await readPilot({ projectId, scriptId: Number(input.scriptId) }, true);
  const rows = (await db("memories").where({ isolationKey: memoryKey(projectId), type: "message" }).orderBy("createTime", "desc").limit(300)).reverse();
  const attachments = rows.length ? await db("o_v04AgentAttachment").where({ projectId }).whereIn("messageId", rows.map(r => r.id)) : [];
  const references = await db("o_v04AgentReference").where({ projectId }).orderBy("createdAt", "asc").limit(300);
  let visionConfigured = false;
  try { await requireModel(projectId, "vision"); visionConfigured = true; }
  catch (error) { if (!(error instanceof ModelConfigError)) throw error; }
  return { isolationKey: memoryKey(projectId), visionConfigured, messages: rows.map(r => ({ id: r.id, role: r.role, content: r.content, createTime: r.createTime, attachments: attachments.filter(a => a.messageId === r.id).map(a => ({ id: a.id, name: a.originalName, mimeType: a.mimeType, bytes: a.bytes, purpose: a.purpose, context: JSON.parse(a.contextJson), references: references.filter(ref => ref.attachmentId === a.id).map(ref => ({ id: ref.id, targetType: ref.targetType, targetKey: ref.targetKey, scriptId: ref.scriptId, assetId: ref.assetId })) })) })) };
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
  const key = memoryKey(ctx.projectId);
  const attachments = await attachmentsForMessage(ctx.projectId, attachmentIds);
  const system = renderProjectAgentSystem(await buildProjectAgentContext({ ...ctx, scriptId: ctx.scriptId! }, message));
  const priorImages = attachments.length ? [] : await db("o_v04AgentAttachment").where({ projectId: ctx.projectId }).whereNotNull("messageId").orderBy("createdAt", "desc").limit(4);
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
  const answer = await answerProjectAgent({ projectId: ctx.projectId, message, system, attachments, priorImages });
  if (answer.status === "VISION_MODEL_REQUIRED" || answer.status === "VISION_ANALYSIS_FAILED")
    return { isolationKey: key, ...answer, applied: false, userMessageId };
  let embedding: number[] | null = null;
  try { embedding = await getEmbedding(answer.reply); }
  catch (error) { if (!missingLocalEmbedding(error)) throw error; }
  await db("memories").insert({ id: randomUUID(), isolationKey: key, type: "message", role: "assistant", content: answer.reply, embedding: embedding ? JSON.stringify(embedding) : null, summarized: 0, createTime: Date.now() });
  return { isolationKey: key, ...answer, applied: false, userMessageId };
});

endpoint("/agent/reanalyze", async input => {
  const data = z.object({ context, userMessageId: z.string().uuid() }).strict().parse(input);
  const ctx = data.context;
  if (ctx.scriptId == null) throw new PilotError("PILOT_UNIT_REQUIRED", "请选择制作单元");
  const key = memoryKey(ctx.projectId);
  const original = await db("memories").where({ id: data.userMessageId, isolationKey: key, type: "message", role: "user" }).first();
  if (!original) throw new PilotError("PILOT_MESSAGE_NOT_FOUND", "这条项目消息不存在", 404);
  const attachments = await db("o_v04AgentAttachment").where({ projectId: ctx.projectId, messageId: data.userMessageId }).limit(4);
  if (!attachments.length) throw new PilotError("PILOT_ATTACHMENT_NOT_FOUND", "这条消息没有可重新分析的图片", 409);
  const system = renderProjectAgentSystem(await buildProjectAgentContext({ ...ctx, scriptId: ctx.scriptId! }, original.content));
  const answer = await answerProjectAgent({ projectId: ctx.projectId, message: original.content, system, attachments, priorImages: [], forceVision: true });
  if (answer.status !== "ANSWERED") return { ...answer, applied: false, userMessageId: data.userMessageId };
  await db("memories").insert({ id: randomUUID(), isolationKey: key, type: "message", role: "assistant", content: answer.reply, embedding: null, summarized: 0, createTime: Date.now() });
  return { ...answer, applied: false, userMessageId: data.userMessageId };
});

export default router;

import {proposeDirector,readDirector} from "./directorBible";
import {previewImageBaseline,listImageBaselines} from './assetImageBaseline';
import {reconcileAutoAssets,autoAssetCoverage} from './autoAsset';
import {wakeDraftWorker} from './studioDraftImage';
import { readAgentAttachment } from "./agentAttachments";
import { analyzeImages } from "./visionAnalyzer";
import { enqueueAssetImageEdit, listAssetImageCandidates, previewAssetImageCandidate, rejectAssetImageCandidate } from "./assetImageEdit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import u from "@/utils";
import { db } from "@/utils/db";
import { ModelConfigError, requireModel } from "@/services/modelPreset";
import { PilotError, readPilot } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { agentActionRequest, explicitAssetCreateRequest, finalizeAgentAction, finalizeStudioAssetCreate, prepareAgentAction, targetConfirmation } from "./agentActionProposal";
import { parseStudioTurnSemantic, StudioSemanticError, studioModeHint, studioTurnFormat } from "./studioTurnSemantic";

const contextSchema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
  currentStage: z.string().max(80), currentRoute: z.string().max(200),
  selectedObject: z.object({ type: z.enum(["PROJECT", "ASSET", "SHOT"]), key: z.string().max(128) }).nullable(),
}).strict();
export const studioTurnRequest = z.object({
  context: contextSchema, message: z.string().trim().min(1).max(8000),
  optionalDraft: agentActionRequest.shape.optionalDraft,
  attachmentIds: z.array(z.string().uuid()).max(4).default([]),
  parentCandidateId: z.string().uuid().optional(),
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

export async function answerStudioTurn(input: unknown, userMessageId?: string, actorUserId?: number) {
  const data = studioTurnRequest.parse(input);
  const ctx = data.context;
  const state = await readPilot({ projectId: ctx.projectId, scriptId: ctx.scriptId });
  const selected = ctx.selectedObject;
  if(/导演(方向|方案|视觉)|整部片.*视觉方向|全片.*视觉|鲸鱼.*(恐怖|怪兽|敬畏)|飞马.*神圣|蓝色物质.*贯穿|不要.*赛博|不要.*游戏.*电影/.test(data.message)){
    const scope={projectId:ctx.projectId,scriptId:ctx.scriptId};const current=await readDirector(scope,actorUserId??0);
    const proposal=await proposeDirector({...scope,userInstruction:data.message,...(current.proposal&&current.proposal.status!=='STALE'?{baseProposalId:current.proposal.id}:{} )},actorUserId??0);
    return {mode:'DIRECTOR_PROPOSAL',reply:'导演方向候选已准备，请审阅变化后人工确认。当前图片不会自动改变。',directorProposal:proposal,applied:false};
  }
  if(/把.*资产.*准备好|准备.*全部.*素材|重新做.*第一稿|怎么.*还没图|为什么.*没有图/.test(data.message)){
    const asset=state.assets.find((a:any)=>selected?.type==='ASSET'&&a.canonicalKey===selected.key)||state.assets.find((a:any)=>data.message.includes(a.name)||data.message.includes(a.canonicalKey));
    if(/重新做/.test(data.message)&&!asset)return {mode:'NEEDS_TARGET_CONFIRMATION',reply:'请选中要重新准备第一稿的素材。',applied:false};
    if(!/怎么|为什么/.test(data.message)){
      await reconcileAutoAssets({projectId:ctx.projectId,scriptId:ctx.scriptId,...(/重新做/.test(data.message)?{regenerateKey:asset!.canonicalKey,requestId:userMessageId??randomUUID()}: {})});wakeDraftWorker();
    }
    const coverage=await autoAssetCoverage({projectId:ctx.projectId,scriptId:ctx.scriptId});
    const item=asset?coverage.items.find(a=>a.canonicalKey===asset.canonicalKey):null;
    return {mode:'DISCUSS',reply:item?`${asset.name}：${item.realRequired?'等待真实素材':({READY:'图片已准备',QUEUED:'正在排队准备',RUNNING:'正在生成',FAILED:'生成遇到问题；旧素材未改变',WAITING_PREPARATION:'视觉草案尚未准备完成'} as Record<string,string>)[item.firstDraftStatus]??'正在准备'}。`:
      `资产图片已准备 ${coverage.firstDraftReady} 项，正在准备 ${coverage.firstDraftRunning} 项。自动图片只是草案，不会替换已确认基准。`,applied:false};
  }
  // Explicit conversational review stays on the same Preview/Confirm boundary.
  // A model reply cannot itself promote a generated image to authority.
  const reviewText=data.message.trim().replace(/[。！!\s]+$/g,'');
  const acceptReview=/^(这个可以|用这张|就用这张|确认用这张|用这张作为正式参考|采用此版本)$/.test(reviewText);
  const rejectReview=/^(不要这个版本|放弃这个候选|不采用这张)$/.test(reviewText);
  if(acceptReview||rejectReview){
    const candidates=await listAssetImageCandidates({projectId:ctx.projectId,scriptId:ctx.scriptId});
    const candidate=candidates.find(c=>(data.parentCandidateId||!c.automatic)&&c.status==='SUCCEEDED' && c.decision!=='REJECTED' &&
      (data.parentCandidateId?c.id===data.parentCandidateId:selected?.type==='ASSET'&&c.canonicalKey===selected.key));
    if(!candidate)return {mode:'NEEDS_TARGET_CONFIRMATION',reply:'请先选中你希望采用或放弃的图片候选。',applied:false};
    if(rejectReview){await rejectAssetImageCandidate({projectId:ctx.projectId,scriptId:ctx.scriptId,jobId:candidate.id});return {mode:'ASSET_IMAGE_REVIEW',reply:'已放弃这张候选，原有素材没有改变。',applied:false};}
    const preview=await previewAssetImageCandidate({projectId:ctx.projectId,scriptId:ctx.scriptId,jobId:candidate.id});
    return {mode:'ASSET_IMAGE_REVIEW',reply:'请在下方确认采用这张候选；现在还没有改变正式参考。',candidatePreview:{...preview,jobId:candidate.id},applied:false};
  }
  if(data.attachmentIds.length&&data.message==='[图片参考]')return {mode:'DISCUSS',reply:'图片已保存为对话参考；尚未设为基准，也没有发起改图。你可以告诉我希望怎样使用它。',applied:false};
  // Explicit uploaded-baseline binding is independent of optional vision.
  const baselineIntent=/(以后|设为|作为|换成|使用).*(基准|脸部参考|面部参考|全身参考|背面参考)/.test(data.message);
  if(baselineIntent){
    const mentioned=state.assets.filter((a:any)=>a.status==='ACTIVE'&&(data.message.includes(a.canonicalKey)||data.message.includes(a.name)));
    const targetKey=mentioned.length===1?mentioned[0].canonicalKey:mentioned.length===0&&selected?.type==='ASSET'?selected.key:null;
    if(!targetKey||data.attachmentIds.length!==1)return {mode:'NEEDS_TARGET_CONFIRMATION',reply:'请选中要关联的素材并上传一张基准图片。',applied:false};
    const role=/脸部|面部/.test(data.message)?'FACE_HERO':/背面/.test(data.message)?'FULL_BODY_BACK':/全身参考/.test(data.message)?'FULL_BODY_FRONT':'GENERAL';
    const baselinePreview=await previewImageBaseline({projectId:ctx.projectId,scriptId:ctx.scriptId,canonicalKey:targetKey,attachmentId:data.attachmentIds[0],role});
    return {mode:'ASSET_IMAGE_BASELINE',reply:'请看图后确认使用；尚未改变当前基准。',baselinePreview,applied:false};
  }
  const actionData = agentActionRequest.parse({ projectId: ctx.projectId, scriptId: ctx.scriptId,
    instruction: data.message, scope: selected ? { type: selected.type, key: selected.key } : { type: "PROJECT" },
    ...(data.optionalDraft ? { optionalDraft: data.optionalDraft } : {}) });
  const createIntent = explicitAssetCreateRequest(data.message);
  const prepared = createIntent ? null : prepareAgentAction(state, actionData);
  const agentContext = await buildProjectAgentContext(ctx, data.message);
  const currentImageBaselines=await listImageBaselines({projectId:ctx.projectId,scriptId:ctx.scriptId});
  const availableReferences=await db('o_v04AgentAttachment').where({projectId:ctx.projectId,scriptId:ctx.scriptId}).whereNotNull('messageId').orderBy('createdAt','desc').limit(12).select('id','originalName','purpose');
  let referenceObservations:unknown[]=[];
  if(data.attachmentIds.length){try{const rows=await Promise.all(data.attachmentIds.map(id=>readAgentAttachment(ctx.projectId,id)));referenceObservations=await analyzeImages(ctx.projectId,rows);}catch(error){console.warn('[V04 AssetEdit][ReferenceObservationUnavailable]',{projectId:ctx.projectId,errorName:error instanceof Error?error.name:'Error'});}}
  const source = createIntent ? { selectedAsset: ctx.selectedObject?.type === "ASSET"
    ? state.assets.find((asset: any) => asset.status === "ACTIVE" && asset.canonicalKey === ctx.selectedObject?.key) ?? null : null,
    activeAssets: state.assets.filter((asset: any) => asset.status === "ACTIVE").map((asset: any) => ({ canonicalKey: asset.canonicalKey, name: asset.name, category: asset.category, assetKind: asset.assetKind })) }
    : prepared && "early" in prepared ? null : prepared?.source;
  const system = `${renderProjectAgentSystem(agentContext)}\n你是同一个 Project Agent 的 Studio 对话模式。${studioTurnFormat}` +
    `mode 必须是 DISCUSS、PROPOSE_CHANGE、ASSET_CREATE、ASSET_IMAGE_EDIT 或 NEEDS_TARGET_CONFIRMATION；reply 是自然、简洁的中文回答。` +
    `本次明确要求用上传图片本身来改图时，imageIntent.sourceAttachmentId 使用真实附件 ID，referenceBindings 为空；只参考风格/光影时，主体仍取资产基准，上传图只放 referenceBindings。仅讨论或称赞图片不能重绘或设基准。用户要求修改现有图片、重做风格或派生大头照/背面时，使用 ASSET_IMAGE_EDIT 而不是 PROPOSE_CHANGE。它生成图片候选，不改变 Visual Spec。imageIntent 的 editMode 为 TEXT_EDIT/REFERENCE_EDIT/DERIVE_VIEW/STYLE_VARIANT；targetRole 为 EDIT_CANDIDATE/STYLE_VARIANT/FACE_HERO/FULL_BODY_FRONT/FULL_BODY_BACK/SIDE_SPECIAL_LEFT/SIDE_SPECIAL_RIGHT/DETAIL_REFERENCE。sourceFocus 为 FACE/BODY/BACK，按实际要修改的部位选择；仅说保留脸不代表 FACE 修改，默认 BODY。preserveIntent 的 identity/face/hairstyle/costume/palette/silhouette/proportions/material/composition 只能为 HIGH/MEDIUM/LOW，默认 HIGH。referenceBindings 只可引用这次给出的真实 attachmentId，role 只能为 STYLE_REFERENCE/COSTUME_REFERENCE/LIGHTING_REFERENCE/MATERIAL_REFERENCE/POSE_REFERENCE/COMPOSITION_REFERENCE/DETAIL_REFERENCE；图用途不明先自然语言追问。仅在用户明确引用历史图片时使用 availableReferenceImages 中的真实 ID；没有本次上传或明确历史引用时为空。canonicalKey 必须是当前选中或用户明确提到的有效素材。不要虚构图片执行成功，reply 只说已提交候选制作。` +
    `疑问、解释、对比和建议用 DISCUSS；只有用户明确要求改变当前对象，才用 PROPOSE_CHANGE，并填写 summary、rationale、patch。` +
    `目标含糊或涉及素材身份的改名、归属、退休等身份级修改时用 NEEDS_TARGET_CONFIRMATION。` +
    `只有用户明确请求新建独立素材时才用 ASSET_CREATE；普通外观细节继续留在现有 Visual Spec。` +
    `ASSET_CREATE 的 asset 使用当前项目真实类别和类型，挂件可用 ACC/PROP；ownerKey 和 relatedKeys 只能引用当前项目已有 canonicalKey。` +
    `新身份只是候选，必须人工预览并确认后才能应用；提案尚未应用，绝不可声称已经改动正式项目。` +
    (createIntent ? "当前请求明确涉及新增独立素材，不要求先有已确认 Visual Spec。" : prepared && "early" in prepared ? "当前没有可直接修改的视觉规格或明确目标。不要虚构视觉规格。" : `\n${prepared?.system}`);
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
  const raw = await invoke(system, JSON.stringify({ message: data.message, selectedObject: selected, source, currentImageBaselines:currentImageBaselines.map((b:any)=>({canonicalKey:b.canonicalKey,role:b.role,attachmentId:b.attachmentId,sourceType:b.sourceType,originalName:b.originalName})), attachmentIds: data.attachmentIds, availableReferenceImages:availableReferences, referenceObservations, activeAssets: state.assets.filter((a:any)=>a.status==="ACTIVE").map((a:any)=>({canonicalKey:a.canonicalKey,name:a.name,sourcePolicy:a.sourcePolicy})) }));
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
  if (turn.mode === "ASSET_IMAGE_EDIT") {
    if(/你觉得|你认为|怎么样|分析这张|这张不错/.test(data.message)&&!/帮我|请.*(?:改|生成)|改得|修改成|重绘|生成/.test(data.message))return {mode:'NEEDS_TARGET_CONFIRMATION',reply:'这次只讨论图片，没有修改或设置基准。你希望换成这张图中的人物，还是只参考它的画风？',applied:false};
    const intent = turn.imageIntent as any;
    const target = state.assets.find((a:any)=>a.status==='ACTIVE' && a.canonicalKey===intent.canonicalKey);
    const mentioned = state.assets.filter((a:any)=>a.status==='ACTIVE' && (data.message.includes(a.canonicalKey)||data.message.includes(a.name)));
    const explicit = target && (mentioned.length===1 ? mentioned[0].canonicalKey===target.canonicalKey : mentioned.length===0 && selected?.type==='ASSET' && selected.key===target.canonicalKey);
    if (!explicit) return {mode:'NEEDS_TARGET_CONFIRMATION',reply:'你希望修改哪项素材？请先选中它。',applied:false};
    if (!userMessageId) throw new PilotError('PILOT_MESSAGE_REQUIRED','图片修改必须关联原始对话消息',409);
    if(/回到基准|从基准|基于基准/.test(data.message))intent.useBaseline=true;
    const allowedRefs=new Set([...data.attachmentIds,...availableReferences.map((r:any)=>r.id)]);
    if(intent.sourceAttachmentId&&!allowedRefs.has(intent.sourceAttachmentId))throw new PilotError('PILOT_REFERENCE_INVALID','本次来源图片不属于当前对话',409);
    if ((intent.referenceBindings??[]).some((r:any)=>!allowedRefs.has(r.attachmentId))) throw new PilotError('PILOT_REFERENCE_INVALID','引用的图片不属于当前对话',409);
    if(data.attachmentIds.length && !intent.sourceAttachmentId && !(intent.referenceBindings??[]).length)return {mode:'NEEDS_TARGET_CONFIRMATION',reply:'你主要希望参考这张图的长相，还是风格和光影？',applied:false};
    let imageCandidate:Awaited<ReturnType<typeof enqueueAssetImageEdit>>;
    try{imageCandidate=await enqueueAssetImageEdit({projectId:ctx.projectId,scriptId:ctx.scriptId},intent,userMessageId,data.parentCandidateId);}
    catch(error){
      if(error instanceof PilotError){const correlationId=randomUUID();console.error('[V04 AssetEdit][PreparationFailure]',{correlationId,projectId:ctx.projectId,code:error.code});throw new StudioTurnFailure(error.code,error.message,'IMAGE_EDIT_PREPARATION_FAILED',correlationId,error.status);}
      studioFailure(ctx,'ACTION_FINALIZATION_FAILED',error);
    }
    return {mode:'ASSET_IMAGE_EDIT',reply:'我已开始准备新的图片候选；现有资产没有被替换。完成后你可以查看、继续修改或采用。',imageCandidate,applied:false};
  }
  if (turn.mode === "DISCUSS") return { mode: turn.mode, reply: turn.reply, applied: false };
  if (turn.mode === "NEEDS_TARGET_CONFIRMATION" || prepared && "early" in prepared) {
    const target = targetConfirmation(state);
    return { mode: "NEEDS_TARGET_CONFIRMATION", reply: prepared && "early" in prepared && prepared.early && "message" in prepared.early
      ? String(prepared.early.message) : turn.reply, candidates: target.candidates, applied: false };
  }
  if (turn.mode === "ASSET_CREATE") {
    if (!createIntent) studioFailure(ctx, "ACTION_FINALIZATION_FAILED", new Error("ASSET_CREATE_WITHOUT_EXPLICIT_INTENT"));
    try { return { mode: "ASSET_CREATE", reply: turn.reply,
      actionProposal: await finalizeStudioAssetCreate(state, actionData, turn), applied: false }; }
    catch (error) { studioFailure(ctx, "ACTION_FINALIZATION_FAILED", error); }
  }
  if (createIntent || !prepared || "early" in prepared) studioFailure(ctx, "ACTION_FINALIZATION_FAILED", new Error("ASSET_CREATE_OUTPUT_REQUIRED"));
  // The existing action compiler validates permitted fields, ownership and the
  // Visual Spec preview. The model never writes authoritative state.
  let actionProposal: Awaited<ReturnType<typeof finalizeAgentAction>>;
  try { actionProposal = await finalizeAgentAction(actionData, prepared, {
    summary: turn.summary, rationale: turn.rationale, patch: turn.patch,
  }); }
  catch (error) { studioFailure(ctx, "ACTION_FINALIZATION_FAILED", error); }
  return { mode: "PROPOSE_CHANGE", reply: turn.reply, actionProposal, applied: false };
}

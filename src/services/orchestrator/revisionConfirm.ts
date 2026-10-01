import type { Knex } from "knex";
import u from "@/utils";
import { z } from "zod";
import { canonicalJson, sha256 } from "@/services/supervisor/contract";
import { storyboardSemanticV2Snapshot } from "@/services/supervisor/registry";
import { productionSpec } from "@/services/storyboardProduction";
import { ProfileError, versionNumber } from "./profileDefinition";
import { captureRevisionPlan, normalizedChangeSet, revisionPreviewRequestSchema } from "./revisionPreview";
import { acquireRevisionBoundary } from "./revisionBoundary";

const db = () => u.db as Knex;
const confirmSchema = revisionPreviewRequestSchema.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevisionEpoch: z.number().int().nonnegative().safe(),
  humanReason: z.string().trim().min(1).max(4000),
}).strict();
type Command = z.infer<typeof confirmSchema>;
const deny = (code: string, message: string, status = 409): never => { throw new ProfileError(code, message, status); };
const maxJson = (value: unknown, max = 1024 * 1024) => {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded, "utf8") > max) deny("REVISION_REQUEST_TOO_LARGE", "修订证据超过大小上限", 413);
  return encoded;
};
type Actor = { id?: unknown; name?: unknown } | null | undefined;

async function authorize(q: Knex.Transaction, command: Pick<Command, "projectId" | "scriptId">, actor: Actor) {
  const configured = process.env.DS_STUDIO_OWNER_USER_ID;
  if (!configured || !/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(Number(configured))) {
    deny("REVISION_ACCESS_DENIED", "尚未配置有效的 Studio 负责人", 403);
  }
  const id = typeof actor?.id === "number" ? actor.id : Number(actor?.id);
  if (!Number.isSafeInteger(id) || id !== Number(configured)) deny("REVISION_ACCESS_DENIED", "当前账号无权确认修订", 403);
  const user = await q("o_user").where({ id }).first("id", "name");
  if (!user || !await q("o_project").where({ id: command.projectId }).first("id") ||
    !await q("o_script").where({ id: command.scriptId, projectId: command.projectId }).first("id")) {
    deny("REVISION_ACCESS_DENIED", "账号或制作单元授权无效", 403);
  }
  return { id, name: String(user.name ?? "").slice(0, 256) };
}

const historySchema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict();
export async function readRevisionHistory(input: unknown, identity: Actor) {
  const parsed = historySchema.safeParse(input);
  if (!parsed.success) deny("REVISION_CHANGE_INVALID", "修订历史查询字段不合法", 400);
  const scope = parsed.data!;
  return db().transaction(async q => {
    await authorize(q, scope, identity);
    const rows = await q("o_productionRevision").where({ projectId: scope.projectId, scriptId: scope.scriptId })
      .orderBy("epochAfter", "desc").limit(scope.limit).offset(scope.offset);
    return rows.map(row => ({ revisionId: row.revisionId, revisionKey: row.revisionKey,
      epochBefore: row.epochBefore, epochAfter: row.epochAfter, humanReason: row.humanReason,
      actorUserId: row.actorUserId, actorDisplayName: row.actorDisplayName,
      appliedAt: row.appliedAt, change: JSON.parse(row.changeJson), impact: JSON.parse(row.impactJson),
      result: JSON.parse(row.resultJson) }));
  });
}

function requestHash(command: Command, actorUserId: number) {
  const { changeSet, humanReason, ...rest } = command;
  return sha256({ ...rest, changeSet: normalizedChangeSet(command), humanReason, actorUserId });
}

async function assertNoRunningWork(q: Knex.Transaction, command: Command) {
  const live = await q("o_revisionWorkGuard").where({ projectId: command.projectId, scriptId: command.scriptId })
    .whereIn("state", ["ACTIVE", "UNCERTAIN"]).orderBy("createdAt", "asc").limit(201)
    .select("guardId", "kind", "trackId", "state");
  if (live.length > 200) deny("REVISION_RUNTIME_UNSAFE", "在飞任务超过安全读取上限");
  if (live.length) deny("REVISION_ASYNC_WORK_BLOCKED", `当前制作单元仍有 ${live.length} 个视频或提示词任务，暂不能确认修订`);
}

async function applySemantic(q: Knex.Transaction, command: Command,
  captured: Awaited<ReturnType<typeof captureRevisionPlan>>["captured"],
  preview: Awaited<ReturnType<typeof captureRevisionPlan>>["preview"], appliedAt: number) {
  const where = { projectId: command.projectId, scriptId: command.scriptId };
  const before = new Map<number, any>(captured.rows.map(row => [Number(row.id), row]));
  const idByRef: Record<string, number> = {};
  const specFields = ["productionMode", "primaryAssetId", "referenceAssetIds", "referenceAssetGroupIds"] as const;
  const changedIds = new Set<number>();
  for (const op of command.changeSet.operations) {
    if (op.type === "EDIT") {
      const row = before.get(op.storyboardId);
      if (!row) deny("REVISION_PREVIEW_STALE", "修订目标已变化");
      const patch: Record<string, unknown> = {};
      for (const field of ["track", "duration", "prompt", "videoDesc"] as const) {
        if (Object.hasOwn(op.patch, field)) patch[field] = field === "duration" ? String(op.patch.duration) : op.patch[field];
      }
      if (specFields.some(field => Object.hasOwn(op.patch, field))) {
        patch.productionSpec = JSON.stringify({ ...productionSpec(row), ...Object.fromEntries(specFields
          .filter(field => Object.hasOwn(op.patch, field)).map(field => [field, op.patch[field]])) });
      }
      if (Object.keys(patch).length && await q("o_storyboard").where({ ...where, id: op.storyboardId }).whereNull("retiredAt").update(patch) !== 1) {
        deny("REVISION_PREVIEW_STALE", "修订目标写入时已变化");
      }
      if (Object.hasOwn(op.patch, "linkedAssetIds")) {
        await q("o_assets2Storyboard").where({ storyboardId: op.storyboardId }).delete();
        if (op.patch.linkedAssetIds?.length) await q("o_assets2Storyboard").insert(op.patch.linkedAssetIds.map(assetId => ({ storyboardId: op.storyboardId, assetId })));
      }
      changedIds.add(op.storyboardId);
    } else if (op.type === "ADD") {
      const s = op.storyboard;
      const [id] = await q("o_storyboard").insert({ ...where, index: s.index ?? 0, track: s.track, duration: String(s.duration),
        prompt: s.prompt, videoDesc: s.videoDesc, productionSpec: JSON.stringify({ schemaVersion: 1,
          productionMode: s.productionMode, primaryAssetId: s.primaryAssetId, referenceAssetIds: s.referenceAssetIds,
          referenceAssetGroupIds: s.referenceAssetGroupIds, promptSkillId: null, promptSkillVersion: null, capabilityId: null }),
        state: "未生成", filePath: "", reason: "", shouldGenerateImage: s.productionMode === "REAL_ASSET_DIRECT" ? 0 : 1,
        createTime: appliedAt });
      idByRef[op.clientRef] = Number(id); changedIds.add(Number(id));
      if (s.linkedAssetIds.length) await q("o_assets2Storyboard").insert(s.linkedAssetIds.map(assetId => ({ storyboardId: id, assetId })));
    } else if (op.type === "RETIRE") {
      if (await q("o_storyboard").where({ ...where, id: op.storyboardId }).whereNull("retiredAt")
        .update({ retiredAt: appliedAt, retiredByRevisionId: command.revisionId }) !== 1) deny("REVISION_PREVIEW_STALE", "退休目标已变化");
      changedIds.add(op.storyboardId);
    }
  }
  // Exact intended order is the planner's result, including implicit ADD indices.
  for (const semantic of preview.proposedSemantic) {
    const id = "clientRef" in semantic ? idByRef[semantic.clientRef] : semantic.id;
    if (!id) deny("REVISION_CONTEXT_INVALID", "ADD 身份映射失败");
    const original = before.get(id);
    if (!original || Number(original.index) !== semantic.index) {
      if (await q("o_storyboard").where({ ...where, id }).whereNull("retiredAt").update({ index: semantic.index }) !== 1) deny("REVISION_PREVIEW_STALE", "分镜序号写入失败");
      changedIds.add(id);
    }
  }
  // Existing track identity is preserved when the exact name stays unchanged.
  // For a changed/new group, reuse one unambiguous active track or create one.
  const active = await q("o_storyboard").where(where).whereNull("retiredAt").orderBy("index", "asc").orderBy("id", "asc");
  const newTrackIds = new Set<number>();
  for (const row of active) {
    if (!changedIds.has(Number(row.id)) && row.trackId != null) continue;
    const original = before.get(Number(row.id));
    if (original && original.track === row.track && original.trackId != null) continue;
    const matches = active.filter(other => other.id !== row.id && other.track === row.track && other.trackId != null)
      .map(other => Number(other.trackId));
    const distinct = [...new Set(matches)];
    if (distinct.length > 1) deny("REVISION_TRACK_CONTEXT_UNSUPPORTED", "同名轨道关系不唯一");
    let trackId = distinct[0];
    if (!trackId) {
      [trackId] = await q("o_videoTrack").insert({ ...where, duration: 0, storyboardManaged: 1 });
      newTrackIds.add(trackId);
    }
    const track = await q("o_videoTrack").where({ ...where, id: trackId }).first();
    if (!track) deny("REVISION_TRACK_CONTEXT_UNSUPPORTED", "轨道归属不一致");
    await q("o_storyboard").where({ ...where, id: row.id }).update({ trackId });
    row.trackId = trackId;
  }
  const trackIds = [...new Set(active.map(row => row.trackId).filter(Boolean))];
  const previousTrackIds = [...new Set([...changedIds].map(id => before.get(id)?.trackId).filter(Boolean))];
  for (const trackId of new Set([...trackIds, ...previousTrackIds])) {
    const track = await q("o_videoTrack").where({ ...where, id: trackId }).first();
    if (!track) deny("REVISION_TRACK_CONTEXT_UNSUPPORTED", "受影响轨道归属不一致");
    const previousGroups = new Set([...before.values()].filter(row => row.trackId === trackId).map(row => row.track));
    const currentGroups = new Set(active.filter(row => row.trackId === trackId).map(row => row.track));
    if (previousGroups.size > 1 || currentGroups.size > 1)
      deny("REVISION_TRACK_CONTEXT_UNSUPPORTED", "轨道曾关联多个不同分镜组，不能安全维护");
    if (track.storyboardManaged == null) await q("o_videoTrack").where({ ...where, id: trackId }).update({ storyboardManaged: 1 });
  }
  for (const trackId of newTrackIds) {
    const storyboardDuration = active.filter(row => row.trackId === trackId).reduce((sum, row) => sum + Number(row.duration), 0);
    await q("o_videoTrack").where({ ...where, id: trackId }).update({ duration: storyboardDuration });
  }
  const links = active.length ? await q("o_assets2Storyboard").whereIn("storyboardId", active.map(row => row.id)).select("storyboardId", "assetId") : [];
  const byShot = new Map<number, number[]>();
  for (const link of links) byShot.set(Number(link.storyboardId), [...(byShot.get(Number(link.storyboardId)) ?? []), Number(link.assetId)]);
  const actual = storyboardSemanticV2Snapshot(active, byShot);
  const intended = preview.proposedSemantic.map(row => {
    if (!("clientRef" in row)) return row;
    const { clientRef, ...fields } = row;
    return { ...fields, id: idByRef[clientRef] };
  });
  if (canonicalJson(actual) !== canonicalJson(intended)) deny("REVISION_CONTEXT_INVALID", "真实分镜语义与已预览结果不一致");
  return { clientRefToId: idByRef, resultTargetHash: sha256(actual), touchedTrackIds: [...new Set([...trackIds, ...previousTrackIds])] };
}

async function invalidateControl(q: Knex.Transaction, command: Command,
  captured: Awaited<ReturnType<typeof captureRevisionPlan>>["captured"],
  preview: Awaited<ReturnType<typeof captureRevisionPlan>>["preview"], appliedAt: number, actor: { id: number; name: string }) {
  const base = { projectId: command.projectId, scriptId: command.scriptId,
    profileKey: captured.profile.key, profileVersion: versionNumber(captured.profile.version) };
  const byStage = new Map(captured.stageRuns.map(row => [row.stageKey, row]));
  for (const transition of preview.stageTransitions) {
    const previous = byStage.get(transition.stageKey);
    if (!previous) deny("REVISION_CONTEXT_INVALID", "不能转换不存在的 StageRun");
    const changed = await q("o_stageRun").where({ ...base, stageKey: transition.stageKey, state: transition.fromState })
      .update({ state: transition.toState, startedAt: transition.eventType === "REOPEN" ? appliedAt : null,
        completedAt: null, skippedAt: null, updatedAt: appliedAt, lastReason: command.humanReason });
    if (changed !== 1) deny("REVISION_CONCURRENT_UPDATE", "Stage 状态已变化，请重新预览");
    await q("o_stageEvent").insert({ ...base, stageKey: transition.stageKey, eventType: transition.eventType,
      fromState: transition.fromState, toState: transition.toState, reason: command.humanReason,
      actorType: "HUMAN", createdAt: appliedAt, revisionId: command.revisionId,
      actorUserId: actor.id, actorDisplayName: actor.name });
  }
  const invalidated: string[] = [];
  for (const item of preview.affectedActiveAttempts) {
    const changed = await q("o_productionAttempt").where({ attemptId: item.attemptId, projectId: command.projectId,
      scriptId: command.scriptId, status: "RUNNING" }).update({ status: "STALE", staleCode: "INVALIDATED_BY_REVISION",
      staleReason: "受控语义修订撤销旧生产授权", invalidatedByRevisionId: command.revisionId,
      completedAt: appliedAt, updatedAt: appliedAt });
    if (changed !== 1) deny("REVISION_CONCURRENT_UPDATE", "图片生产所有权已变化，请重新预览");
    await q("o_storyboard").where({ projectId: command.projectId, scriptId: command.scriptId,
      id: item.subjectId, activeImageAttemptId: item.attemptId })
      .update({ activeImageAttemptId: null });
    await q("o_compositeAttempt").where({ productionAttemptId: item.attemptId })
      .update({ status: "STALE", errorCode: "INVALIDATED_BY_REVISION", error: "受控语义修订撤销旧生产授权", updatedAt: appliedAt });
    invalidated.push(item.attemptId);
  }
  return invalidated;
}

export async function confirmRevision(input: unknown, identity: Actor) {
  if (process.env.DS_REVISION_CONFIRM_ENABLED !== "true") deny("REVISION_RUNTIME_UNSAFE", "受控修订确认尚未启用", 503);
  maxJson(input);
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) deny("REVISION_CHANGE_INVALID", "Revision Confirm 请求字段不合法", 400);
  const command = parsed.data!;
  try {
    return await db().transaction(async q => {
      await acquireRevisionBoundary(q, command.projectId, command.scriptId);
      const actor = await authorize(q, command, identity);
      const hash = requestHash(command, actor.id);
      const prior = await q("o_productionRevision").where({ revisionId: command.revisionId }).first();
      if (prior) {
        if (prior.projectId !== command.projectId || prior.scriptId !== command.scriptId || prior.requestHash !== hash) {
          deny("REVISION_ID_CONFLICT", "此 revisionId 已用于其他修订");
        }
        return { ...JSON.parse(prior.resultJson), delivery: "REPLAYED" };
      }
      const { preview, captured } = await captureRevisionPlan(q, {
        schemaVersion: command.schemaVersion, revisionId: command.revisionId,
        projectId: command.projectId, scriptId: command.scriptId,
        revisionKey: command.revisionKey, changeSet: command.changeSet,
      });
      if (captured.revisionEpoch !== command.expectedRevisionEpoch || preview.previewHash !== command.previewHash) {
        deny("REVISION_PREVIEW_STALE", "预览依据或修订代次已变化，请重新预览");
      }
      await assertNoRunningWork(q, command);
      const appliedAt = Date.now();
      const semantic = await applySemantic(q, command, captured, preview, appliedAt);
      const invalidatedAttemptIds = await invalidateControl(q, command, captured, preview, appliedAt, actor);
      const epochAfter = command.expectedRevisionEpoch + 1;
      if (!Number.isSafeInteger(epochAfter) || await q("o_script").where({ id: command.scriptId, projectId: command.projectId,
        revisionEpoch: command.expectedRevisionEpoch }).update({ revisionEpoch: epochAfter }) !== 1) {
        deny("REVISION_CONCURRENT_UPDATE", "制作单元修订代次已变化");
      }
      const result = { schemaVersion: 1, revisionId: command.revisionId, revisionKey: command.revisionKey,
        projectId: command.projectId, scriptId: command.scriptId, epochBefore: command.expectedRevisionEpoch,
        epochAfter, previewHash: command.previewHash, sourceTargetHash: preview.sourceTargetHash,
        proposedSemanticHash: preview.proposedSemanticHash, resultTargetHash: semantic.resultTargetHash,
        clientRefToId: semantic.clientRefToId, stageTransitions: preview.stageTransitions,
        invalidatedAttemptIds, touchedTrackIds: semantic.touchedTrackIds, appliedAt, delivery: "APPLIED" };
      await q("o_productionRevision").insert({ revisionId: command.revisionId, projectId: command.projectId,
        scriptId: command.scriptId, revisionKey: command.revisionKey, requestHash: hash, previewHash: command.previewHash,
        epochBefore: command.expectedRevisionEpoch, epochAfter, humanReason: command.humanReason,
        actorUserId: actor.id, actorDisplayName: actor.name, createdAt: appliedAt, appliedAt,
        changeJson: maxJson({ schemaVersion: 1, changeSet: normalizedChangeSet(command),
          profile: preview.profile, recipe: preview.recipe, sourceTargetHash: preview.sourceTargetHash,
          proposedSemanticHash: preview.proposedSemanticHash, clientRefToId: semantic.clientRefToId }),
        impactJson: maxJson({ schemaVersion: 1, stageRunsBefore: captured.stageRuns,
          stageTransitions: preview.stageTransitions, affectedActiveAttempts: preview.affectedActiveAttempts,
          invalidatedAttemptIds, outputImpact: preview.outputImpact, touchedTrackIds: semantic.touchedTrackIds }),
        resultJson: maxJson(result) });
      return result;
    });
  } catch (error: any) {
    if (error instanceof ProfileError) throw error;
    if (/SQLITE_BUSY|SQLITE_LOCKED/.test(String(error?.code))) deny("REVISION_CONCURRENT_UPDATE", "数据库正在处理其他写入，请使用同一修订 ID 重试");
    throw error;
  }
}

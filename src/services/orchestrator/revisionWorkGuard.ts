import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import u from "@/utils";
import { readState } from "@/services/advertisementGate";
import { reviewForGate } from "@/services/supervisor/registry";
import { supervisorStageGate } from "@/services/supervisor/review";
import { acquireRevisionBoundary, currentRevisionEpoch } from "./revisionBoundary";
import { ProfileError, positiveId, versionNumber } from "./profileDefinition";
import { resolveProfile } from "./profileRegistry";

const db = () => u.db as Knex;
const ownerRunId = randomUUID();
const blocked = (code: string, message: string): never => { throw new ProfileError(code, message, 409); };
type Kind = "VIDEO_GENERATE" | "VIDEO_PROMPT";
type Reference = { id: number; sources: string };
type WorkItem = { trackId: number; references: Reference[]; videoPath?: string };
type Scope = { projectId: number; scriptId: number };
type Guard = { guardId: string; trackId: number; kind: Kind; admittedEpoch: number; videoId: number | null };

export async function assertCurrentPermission(q: Knex.Transaction, scope: Scope, epoch: number) {
  const profile = await resolveProfile({ projectId: scope.projectId }, q);
  if (!profile.managed || profile.definition.schemaVersion !== 2) return false;
  const reviewStage = profile.definition.stages.find(stage => stage.exitGateKey && (() => {
    try { return reviewForGate(stage.exitGateKey!).targetAdapterKey === "storyboard.semantic.v2"; }
    catch { return false; }
  })());
  const owner = profile.definition.stages.find(stage => stage.stageKey === "storyboard-board");
  if (!owner || !reviewStage) return blocked("REVISION_RUNTIME_UNSAFE", "精确 Profile 没有可验证的 Semantic V2 审核链路");
  if (profile.profileKey === "advertisement") {
    const assets = await readState(scope.projectId, scope.scriptId, q);
    if (!assets.ready) blocked("ADVERTISEMENT_ASSET_GATE_BLOCKED", "广告资产 Gate 未通过");
  }
  if (epoch > 0) {
    const run = await q("o_stageRun").where({ projectId: scope.projectId, scriptId: scope.scriptId,
      profileKey: profile.profileKey, profileVersion: versionNumber(profile.version), stageKey: owner.stageKey }).first("state");
    if (!(run?.state === "COMPLETED" || run?.state === "SKIPPED" && owner.allowSkip && !owner.required))
      blocked("REVISION_STAGE_REVIEW_REQUIRED", "请先完成当前修订的 Storyboard 工序");
    const review = await supervisorStageGate(reviewStage.exitGateKey!, { ...scope, profileKey: profile.profileKey,
      profileVersion: profile.version }, q);
    if (!review.pass) blocked(review.code, review.reason ?? "当前修订尚未通过 Supervisor Review");
  }
  return true;
}

async function validateItem(q: Knex.Transaction, scope: Scope, item: WorkItem) {
  positiveId(item.trackId);
  const track = await q("o_videoTrack").where({ ...scope, id: item.trackId }).first();
  if (!track) blocked("REVISION_WORK_SCOPE_INVALID", "视频轨道不属于当前制作单元");
  if (track.storyboardManaged === 1 && !await q("o_storyboard").where(scope).where({ trackId: item.trackId }).whereNull("retiredAt").first("id"))
    blocked("REVISION_TRACK_RETIRED", "历史轨道不能发起新生产");
  if (item.references.length > 200) blocked("REVISION_WORK_SCOPE_INVALID", "素材输入超过上限");
  for (const ref of item.references) {
    positiveId(ref.id);
    if (ref.sources === "storyboard") {
      const shot = await q("o_storyboard").where({ ...scope, id: ref.id }).whereNull("retiredAt").first("id", "trackId");
      if (!shot || shot.trackId !== item.trackId) blocked("REVISION_WORK_SCOPE_INVALID", "分镜素材不是当前轨道的有效镜头");
    } else if (ref.sources === "assets") {
      const asset = await q("o_assets").where({ projectId: scope.projectId, id: ref.id }).first("id", "scriptId");
      const linked = await q("o_scriptAssets").where({ scriptId: scope.scriptId, assetId: ref.id }).first("assetId");
      if (!asset || asset.scriptId != null && asset.scriptId !== scope.scriptId || !linked)
        blocked("REVISION_WORK_SCOPE_INVALID", "素材不属于当前制作单元");
    } else blocked("REVISION_WORK_SCOPE_INVALID", "素材来源类型不支持");
  }
}

// Returns null only for Legacy/non-ENFORCED scopes. For controlled V2, every
// admitted worker gets its own durable identity before any media preparation.
export async function admitRevisionWork(scope: Scope, kind: Kind, items: WorkItem[]): Promise<Guard[] | null> {
  if (!items.length || items.length > 200 || new Set(items.map(item => item.trackId)).size !== items.length && kind === "VIDEO_PROMPT")
    blocked("REVISION_WORK_SCOPE_INVALID", "任务列表为空、过长或包含重复提示词轨道");
  return db().transaction(async q => {
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    const epoch = await currentRevisionEpoch(q, scope.projectId, scope.scriptId);
    if (!await assertCurrentPermission(q, scope, epoch)) return null;
    const now = Date.now(), result: Guard[] = [];
    for (const item of items) {
      await validateItem(q, scope, item);
      if (kind === "VIDEO_PROMPT" && await q("o_revisionWorkGuard").where(scope).where({ kind, trackId: item.trackId })
        .whereIn("state", ["ACTIVE", "UNCERTAIN"]).first("guardId")) blocked("REVISION_ASYNC_WORK_BLOCKED", "该轨道已有提示词任务");
    }
    for (const item of items) {
      const guardId = randomUUID();
      await q("o_revisionWorkGuard").insert({ guardId, ...scope, kind, trackId: item.trackId,
        admittedEpoch: epoch, ownerRunId, state: "ACTIVE", outcome: null, createdAt: now,
        settledAt: null, resolutionJson: null });
      let videoId: number | null = null;
      if (kind === "VIDEO_GENERATE") {
        if (!item.videoPath) blocked("REVISION_WORK_SCOPE_INVALID", "视频输出路径缺失");
        [videoId] = await q("o_video").insert({ ...scope, videoTrackId: item.trackId,
          filePath: item.videoPath, time: now, state: "生成中", revisionWorkGuardId: guardId });
      } else {
        await q("o_videoTrack").where({ ...scope, id: item.trackId }).update({ state: "生成中" });
      }
      result.push({ guardId, trackId: item.trackId, kind, admittedEpoch: epoch, videoId });
    }
    return result;
  });
}

export async function settleRevisionWork(scope: Scope, guard: Guard, outcome: "SUCCEEDED" | "FAILED",
  payload: { prompt?: string; error?: string } = {}) {
  return db().transaction(async q => {
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    const row = await q("o_revisionWorkGuard").where({ ...scope, guardId: guard.guardId }).first();
    if (!row || row.state !== "ACTIVE" || row.ownerRunId !== ownerRunId || row.admittedEpoch !== guard.admittedEpoch) return "FENCED";
    const epoch = await currentRevisionEpoch(q, scope.projectId, scope.scriptId);
    if (epoch !== guard.admittedEpoch) {
      await q("o_revisionWorkGuard").where({ guardId: guard.guardId, state: "ACTIVE" }).update({ state: "UNCERTAIN",
        resolutionJson: JSON.stringify({ code: "REVISION_EPOCH_CHANGED" }) });
      return "UNCERTAIN";
    }
    try { if (!await assertCurrentPermission(q, scope, epoch)) return "FENCED"; }
    catch { await q("o_revisionWorkGuard").where({ guardId: guard.guardId, state: "ACTIVE" }).update({ state: "UNCERTAIN",
      resolutionJson: JSON.stringify({ code: "REVISION_PERMISSION_CHANGED" }) }); return "UNCERTAIN"; }
    if (row.kind === "VIDEO_GENERATE") {
      const video = await q("o_video").where({ ...scope, id: guard.videoId, videoTrackId: row.trackId,
        revisionWorkGuardId: guard.guardId }).first("id");
      if (!video) {
        await q("o_revisionWorkGuard").where({ guardId: guard.guardId, state: "ACTIVE" }).update({ state: "UNCERTAIN",
          resolutionJson: JSON.stringify({ code: "VIDEO_TARGET_MISSING" }) });
        return "UNCERTAIN";
      }
      await q("o_video").where({ ...scope, id: guard.videoId, revisionWorkGuardId: guard.guardId })
        .update(outcome === "SUCCEEDED" ? { state: "生成成功" } : { state: "生成失败", errorReason: payload.error ?? "视频生成失败" });
    } else {
      const track = await q("o_videoTrack").where({ ...scope, id: row.trackId }).first("id");
      if (!track) {
        await q("o_revisionWorkGuard").where({ guardId: guard.guardId, state: "ACTIVE" }).update({ state: "UNCERTAIN",
          resolutionJson: JSON.stringify({ code: "PROMPT_TRACK_MISSING" }) });
        return "UNCERTAIN";
      }
      await q("o_videoTrack").where({ ...scope, id: row.trackId }).update(outcome === "SUCCEEDED" ?
        { state: "已完成", prompt: payload.prompt ?? "", promptRevisionEpoch: epoch } :
        { state: "生成失败", reason: payload.error ?? "提示词生成失败" });
    }
    const changed = await q("o_revisionWorkGuard").where({ guardId: guard.guardId, state: "ACTIVE", ownerRunId })
      .update({ state: "SETTLED", outcome, settledAt: Date.now(), resolutionJson: payload.error ? JSON.stringify({ error: payload.error.slice(0, 1000) }) : null });
    if (changed !== 1) blocked("REVISION_CONCURRENT_UPDATE", "任务归属已变化");
    return "SETTLED";
  });
}

export async function fenceRevisionWork(scope: Scope, guardId: string, actor: { id?: number | string } | null | undefined, reason: string) {
  const configured = process.env.DS_STUDIO_OWNER_USER_ID;
  const actorId = Number(actor?.id);
  if (!configured || !/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(Number(configured)) ||
    !Number.isSafeInteger(actorId) || actorId !== Number(configured) || !reason.trim())
    blocked("REVISION_ACCESS_DENIED", "只有已配置的 Studio 负责人可撤销写入权");
  return db().transaction(async q => {
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    if (!await q("o_user").where({ id: actorId }).first("id") ||
      !await q("o_project").where({ id: scope.projectId }).first("id"))
      blocked("REVISION_ACCESS_DENIED", "负责人或项目授权无效");
    const guard = await q("o_revisionWorkGuard").where({ ...scope, guardId }).first();
    if (!guard || !["ACTIVE", "UNCERTAIN"].includes(guard.state)) blocked("REVISION_WORK_NOT_RECOVERABLE", "任务不处于可恢复状态");
    await q("o_revisionWorkGuard").where({ ...scope, guardId }).update({ state: "FENCED", settledAt: Date.now(),
      resolutionJson: JSON.stringify({ reason: reason.trim().slice(0, 1000), actorUserId: actorId, previousState: guard.state, at: Date.now() }) });
    return { guardId, state: "FENCED" };
  });
}

import type { Knex } from "knex";
import u from "@/utils";
import { ProfileError } from "./profileDefinition";
import { acquireRevisionBoundary, currentRevisionEpoch } from "./revisionBoundary";
import { resolveProfile } from "./profileRegistry";

const db = () => u.db as Knex;
export async function usesControlledRevision(projectId: number) {
  if (!await db()("sqlite_master").where({ type: "table", name: "o_projectProfileBinding" }).first("name")) return false;
  const profile = await resolveProfile({ projectId });
  return profile.managed && profile.definition.schemaVersion === 2 &&
    profile.definition.stages.some(stage => stage.stageKey === "storyboard-board");
}
export const controlledRevisionRequired = () => new ProfileError("CONTROLLED_REVISION_REQUIRED",
  "受控 Semantic V2 分镜必须通过 Preview 与 Confirm 修订", 409);

export async function isControlledSemanticV2(q: Knex | Knex.Transaction, projectId: number, scriptId: number) {
  if (!await q("sqlite_master").where({ type: "table", name: "o_projectProfileBinding" }).first("name")) return false;
  const scope = await q("o_script").where({ id: scriptId, projectId }).first("id");
  if (!scope) throw new ProfileError("REVISION_SCOPE_INVALID", "制作单元不存在或不属于当前项目", 404);
  const profile = await resolveProfile({ projectId }, q);
  return profile.managed && profile.definition.schemaVersion === 2 &&
    profile.definition.stages.some(stage => stage.stageKey === "storyboard-board");
}

// Unsupported semantic mutations call this inside their own mutation
// transaction. It serializes with Confirm before reading the exact profile.
export async function assertDirectSemanticWriteAllowed(q: Knex.Transaction, projectId: number, scriptId: number) {
  if (!await isControlledSemanticV2(q, projectId, scriptId)) return;
  await acquireRevisionBoundary(q, projectId, scriptId);
  if (await isControlledSemanticV2(q, projectId, scriptId)) throw controlledRevisionRequired();
}

// For old multi-statement endpoints that cannot be safely migrated to an
// atomic write path yet, refuse protected scopes before the first write.
export async function rejectControlledSemanticWrite(projectId: number, scriptId: number) {
  await db().transaction(async q => assertDirectSemanticWriteAllowed(q, projectId, scriptId));
}

export async function controlledTrackContext(q: Knex.Transaction, trackId: number) {
  const track = await q("o_videoTrack").where({ id: trackId }).first();
  if (!track) throw new ProfileError("REVISION_WORK_SCOPE_INVALID", "轨道不存在", 404);
  const projectId = Number(track.projectId), scriptId = Number(track.scriptId);
  if (!await isControlledSemanticV2(q, projectId, scriptId))
    return { track, projectId, scriptId, controlled: false, epoch: 0 };
  await acquireRevisionBoundary(q, projectId, scriptId);
  if (!await isControlledSemanticV2(q, projectId, scriptId))
    throw new ProfileError("REVISION_RUNTIME_UNSAFE", "Profile 在事务内发生变化", 409);
  return { track, projectId, scriptId, controlled: true,
    epoch: await currentRevisionEpoch(q, projectId, scriptId) };
}

export async function assertTrackNotBusy(q: Knex.Transaction, scope: { projectId: number; scriptId: number }, trackId: number) {
  const live = await q("o_revisionWorkGuard").where({ projectId: scope.projectId, scriptId: scope.scriptId }).where({ trackId })
    .whereIn("state", ["ACTIVE", "UNCERTAIN"]).first("guardId");
  if (live) throw new ProfileError("REVISION_ASYNC_WORK_BLOCKED", "轨道存在未结算的后台任务", 409);
}

export async function assertActiveManagedTrack(q: Knex.Transaction, scope: { projectId: number; scriptId: number }, track: any) {
  if (track.storyboardManaged !== 1) return;
  if (!await q("o_storyboard").where({ projectId: scope.projectId, scriptId: scope.scriptId }).where({ trackId: track.id }).whereNull("retiredAt").first("id"))
    throw new ProfileError("REVISION_TRACK_RETIRED", "历史轨道不可作为当前生产目标", 409);
}

export async function rejectProtectedUnitDeletion(projectId: number, scriptId: number) {
  await db().transaction(async q => {
    if (await isControlledSemanticV2(q, projectId, scriptId) ||
      await q("o_productionRevision").where({ projectId, scriptId }).first("revisionId") ||
      await q("o_revisionWorkGuard").where({ projectId, scriptId }).first("guardId"))
      throw new ProfileError("CONTROLLED_REVISION_REQUIRED", "受控修订或后台写入历史不能通过旧删除入口清除", 409);
  });
}

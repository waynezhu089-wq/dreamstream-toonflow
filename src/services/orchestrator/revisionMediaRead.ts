import type { Knex } from "knex";
import u from "@/utils";
import { isControlledSemanticV2 } from "./revisionWriteSafety";
import { currentRevisionEpoch } from "./revisionBoundary";

const db = () => u.db as Knex;

export async function guardedVideoIsCurrent(q: Knex | Knex.Transaction,
  scope: { projectId: number; scriptId: number }, video: any, epoch: number) {
  if (!video?.revisionWorkGuardId || Number(video.projectId) !== scope.projectId ||
    Number(video.scriptId) !== scope.scriptId) return false;
  return Boolean(await q("o_revisionWorkGuard").where({ guardId: video.revisionWorkGuardId,
    ...scope, kind: "VIDEO_GENERATE", trackId: video.videoTrackId, admittedEpoch: epoch,
    state: "SETTLED", outcome: "SUCCEEDED" }).first("guardId"));
}

// Read-only compatibility projection. Raw video and selected IDs remain in
// storage; an old candidate is never silently promoted into the new epoch.
export async function revisionMediaProjection(projectId: number, scriptId: number, videos: any[]) {
  const controlled = await isControlledSemanticV2(db(), projectId, scriptId);
  const guardIds = [...new Set(videos.map(video => video.revisionWorkGuardId).filter(Boolean))];
  const epoch = controlled || guardIds.length ? await currentRevisionEpoch(db(), projectId, scriptId) : 0;
  const guards = guardIds.length ? await db()("o_revisionWorkGuard").where({ projectId, scriptId })
    .whereIn("guardId", guardIds).select("guardId", "kind", "trackId", "admittedEpoch", "state", "outcome") : [];
  const current = new Map(guards.filter(row => row.kind === "VIDEO_GENERATE" && row.admittedEpoch === epoch &&
    row.state === "SETTLED" && row.outcome === "SUCCEEDED")
    .map(row => [row.guardId, row]));
  return { epoch, controlled, status: (video: any) => {
    if (video.revisionWorkGuardId) {
      const guard = current.get(video.revisionWorkGuardId);
      return guard && guard.trackId === video.videoTrackId &&
        Number(video.projectId) === projectId && Number(video.scriptId) === scriptId ?
        "CURRENT" as const : "HISTORICAL" as const;
    }
    return !controlled || epoch === 0 ? "LEGACY" as const : "HISTORICAL" as const;
  } };
}

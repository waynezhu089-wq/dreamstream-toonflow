import type { Knex } from "knex";
import u from "@/utils";
import { isControlledSemanticV2 } from "./revisionWriteSafety";
import { currentRevisionEpoch } from "./revisionBoundary";

const db = () => u.db as Knex;

// Read-only compatibility projection. Raw video and selected IDs remain in
// storage; an old candidate is never silently promoted into the new epoch.
export async function revisionMediaProjection(projectId: number, scriptId: number, videos: any[]) {
  if (!await isControlledSemanticV2(db(), projectId, scriptId))
    return { epoch: 0, controlled: false, status: (_video: any) => "LEGACY" as const };
  const epoch = await currentRevisionEpoch(db(), projectId, scriptId);
  const guardIds = [...new Set(videos.map(video => video.revisionWorkGuardId).filter(Boolean))];
  const guards = guardIds.length ? await db()("o_revisionWorkGuard").where({ projectId, scriptId })
    .whereIn("guardId", guardIds).select("guardId", "trackId", "admittedEpoch", "state", "outcome") : [];
  const current = new Map(guards.filter(row => row.admittedEpoch === epoch && row.state === "SETTLED" && row.outcome === "SUCCEEDED")
    .map(row => [row.guardId, row]));
  return { epoch, controlled: true, status: (video: any) => {
    const guard = current.get(video.revisionWorkGuardId);
    return guard && guard.trackId === video.videoTrackId ? "CURRENT" as const :
      epoch === 0 ? "LEGACY" as const : "HISTORICAL" as const;
  } };
}

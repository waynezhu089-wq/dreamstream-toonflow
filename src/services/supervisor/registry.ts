import type { Knex } from "knex";
import { SupervisorError, canonicalJson, sha256 } from "./contract";
import { productionSpec, semanticProductionSpec } from "@/services/storyboardProduction";

type Query = Knex | Knex.Transaction;
export type Target = { targetAdapterKey: string; targetType: string; targetHash: string; summary: string; snapshot: unknown };
type TargetAdapter = (q: Query, projectId: number, scriptId: number) => Promise<Target>;
export type ReviewDefinition = { reviewKey: string; displayName: string; targetAdapterKey: string; humanDecisions: readonly ["PASS", "REVISE"]; aiDecisions?: readonly ["PASS", "REVISE", "HUMAN_CONFIRM"]; supervisorSkillType?: "SUPERVISOR"; supervisorSkillStageKey?: string; gateKey: string };
const reviews = new Map<string, ReviewDefinition>();
const targets = new Map<string, TargetAdapter>();
export function registerReview(definition: ReviewDefinition) { reviews.set(definition.reviewKey, Object.freeze(definition)); }
export function registerTarget(key: string, adapter: TargetAdapter) { targets.set(key, adapter); }
export function reviewDefinition(key: string) {
  const definition = reviews.get(key);
  if (!definition) throw new SupervisorError("SUPERVISOR_REVIEW_KEY_NOT_REGISTERED", "Supervisor Review 类型未注册", 404);
  return definition;
}
export function reviewForGate(key: string) {
  const definition = [...reviews.values()].find(item => item.gateKey === key);
  if (!definition) throw new SupervisorError("SUPERVISOR_REVIEW_KEY_NOT_REGISTERED", "Supervisor Gate 未关联 Review 类型", 404);
  return definition;
}
export async function readTarget(q: Query, definition: ReviewDefinition, projectId: number, scriptId: number) {
  const adapter = targets.get(definition.targetAdapterKey);
  if (!adapter) throw new SupervisorError("SUPERVISOR_TARGET_ADAPTER_NOT_REGISTERED", "Supervisor 目标读取器未注册", 503);
  try { return await adapter(q, projectId, scriptId); }
  catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError("SUPERVISOR_TARGET_UNAVAILABLE", "Storyboard 审核目标暂时无法读取", 503);
  }
}

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
registerTarget("storyboard.semantic.v1", async (q, projectId, scriptId) => {
  const rows = await q("o_storyboard").where({ projectId, scriptId }).orderBy("index", "asc").orderBy("id", "asc")
    .select("id", "index", "duration", "prompt", "videoDesc", "shouldGenerateImage", "productionSpec");
  if (!rows.length) throw new SupervisorError("SUPERVISOR_TARGET_EMPTY", "当前制作单元暂无分镜，无法审核", 409);
  const links = await q("o_assets2Storyboard").whereIn("storyboardId", rows.map(row => row.id)).select("storyboardId", "assetId");
  const byStoryboard = new Map<number, number[]>();
  for (const link of links) {
    const list = byStoryboard.get(Number(link.storyboardId)) ?? [];
    list.push(Number(link.assetId)); byStoryboard.set(Number(link.storyboardId), list);
  }
  const snapshot = rows.map(row => {
    let productionSpec: unknown = null;
    if (row.productionSpec !== null && row.productionSpec !== undefined) {
      try { productionSpec = JSON.parse(row.productionSpec); } catch { throw new SupervisorError("SUPERVISOR_TARGET_UNAVAILABLE", "分镜 Production Spec 无效", 503); }
    }
    return { id: Number(row.id), index: Number(row.index), duration: row.duration ?? null, prompt: row.prompt ?? null, videoDesc: row.videoDesc ?? null,
      shouldGenerateImage: row.shouldGenerateImage === null ? null : Number(row.shouldGenerateImage), productionSpec,
      linkedAssetIds: (byStoryboard.get(Number(row.id)) ?? []).sort((a, b) => a - b) };
  });
  const encoded = canonicalJson(snapshot);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_BYTES) throw new SupervisorError("SUPERVISOR_TARGET_UNAVAILABLE", "分镜审核快照过大", 503);
  return { targetAdapterKey: "storyboard.semantic.v1", targetType: "STORYBOARD_SEMANTIC", targetHash: sha256(snapshot), summary: `${snapshot.length} 个分镜`, snapshot };
});
registerReview({ reviewKey: "storyboard.semantic-approval", displayName: "Storyboard Semantic Approval", targetAdapterKey: "storyboard.semantic.v1", humanDecisions: ["PASS", "REVISE"], aiDecisions: ["PASS", "REVISE", "HUMAN_CONFIRM"], supervisorSkillType: "SUPERVISOR", supervisorSkillStageKey: "supervisor-review", gateKey: "supervisor.storyboard-approved" });

registerTarget("storyboard.semantic.v2", async (q, projectId, scriptId) => {
  const rows = await q("o_storyboard").where({ projectId, scriptId }).orderBy("index", "asc").orderBy("id", "asc")
    .select("id", "index", "track", "duration", "prompt", "videoDesc", "productionSpec");
  if (!rows.length) throw new SupervisorError("SUPERVISOR_TARGET_EMPTY", "当前制作单元暂无分镜，无法审核", 409);
  const links = await q("o_assets2Storyboard").whereIn("storyboardId", rows.map(row => row.id)).select("storyboardId", "assetId");
  const byStoryboard = new Map<number, number[]>();
  for (const link of links) {
    const list = byStoryboard.get(Number(link.storyboardId)) ?? [];
    list.push(Number(link.assetId)); byStoryboard.set(Number(link.storyboardId), list);
  }
  const snapshot = rows.map(row => {
    const duration = row.duration == null ? null : Number(row.duration);
    if (duration !== null && (!Number.isFinite(duration) || String(row.duration).trim() === "")) throw new SupervisorError("SUPERVISOR_TARGET_UNAVAILABLE", "分镜时长无效", 503);
    let semantic: ReturnType<typeof semanticProductionSpec>;
    try { semantic = semanticProductionSpec(productionSpec(row)); }
    catch { throw new SupervisorError("SUPERVISOR_TARGET_UNAVAILABLE", "分镜 Production Spec 无效", 503); }
    return { id: Number(row.id), index: Number(row.index), track: row.track ?? null, duration,
      prompt: row.prompt ?? null, videoDesc: row.videoDesc ?? null, ...semantic,
      linkedAssetIds: (byStoryboard.get(Number(row.id)) ?? []).sort((a, b) => a - b) };
  });
  if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) throw new SupervisorError("SUPERVISOR_TARGET_UNAVAILABLE", "分镜审核快照过大", 503);
  return { targetAdapterKey: "storyboard.semantic.v2", targetType: "STORYBOARD_SEMANTIC", targetHash: sha256(snapshot), summary: `${snapshot.length} 个分镜`, snapshot };
});
registerReview({ reviewKey: "storyboard.semantic-approval.v2", displayName: "Storyboard Semantic Approval V2", targetAdapterKey: "storyboard.semantic.v2", humanDecisions: ["PASS", "REVISE"], aiDecisions: ["PASS", "REVISE", "HUMAN_CONFIRM"], supervisorSkillType: "SUPERVISOR", supervisorSkillStageKey: "supervisor-review", gateKey: "supervisor.storyboard-approved.v2" });

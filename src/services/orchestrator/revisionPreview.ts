import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { assessCurrentImageOutput, captureStoryboardImageSourceContext, loadCurrentCapabilityEvidence,
  storyboardImageSourceFromContext } from "@/services/productionAttempt";
import { canonicalJson, sha256 } from "@/services/supervisor/contract";
import { reviewForGate, storyboardSemanticV2Snapshot } from "@/services/supervisor/registry";
import { productionSpec } from "@/services/storyboardProduction";
import { resolveEffectiveImageCapability } from "@/services/recipeImageCapability";
import { isRegistryImageSelection } from "@/services/storyboardImageCapability";
import { recipeHash, validateRecipeDefinition } from "@/services/recipeContract";
import { definitionHash, positiveId, ProfileError, versionNumber } from "./profileDefinition";
import { resolveProfile } from "./profileRegistry";

const db = () => u.db as Knex;
const MAX_SHOTS = 200, MAX_OPERATIONS = 200, MAX_BYTES = 1024 * 1024, MAX_ATTEMPTS = 500;
const definition = Object.freeze({ schemaVersion: 1, revisionKey: "storyboard.semantic.v2",
  targetAdapterKey: "storyboard.semantic.v2", ownerStageKey: "storyboard-board" });
const id = z.number().int().positive();
const assetIds = z.array(id).max(200).refine(v => new Set(v).size === v.length);
const groupIds = z.array(z.string().min(1).max(128)).max(200).refine(v => new Set(v).size === v.length);
const mode = z.enum(["REAL_ASSET_DIRECT", "AI_TEXT_TO_IMAGE", "AI_REFERENCE_GENERATE", "REAL_AI_COMPOSITE"]);
const semanticFields = {
  track: z.string().max(256).nullable(), duration: z.number().finite().positive(),
  prompt: z.string().max(20000).nullable(), videoDesc: z.string().max(20000).nullable(),
  productionMode: mode, primaryAssetId: id.nullable(), referenceAssetIds: assetIds,
  referenceAssetGroupIds: groupIds, linkedAssetIds: assetIds,
};
const patchSchema = z.object(semanticFields).partial().strict().refine(v => Object.keys(v).length > 0);
const addSchema = z.object({ ...semanticFields, index: z.number().int().nonnegative().optional() }).strict();
const ref = z.union([z.object({ storyboardId: id }).strict(), z.object({ clientRef: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/) }).strict()]);
const operation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("EDIT"), storyboardId: id, patch: patchSchema }).strict(),
  z.object({ type: z.literal("ADD"), clientRef: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/), storyboard: addSchema }).strict(),
  z.object({ type: z.literal("RETIRE"), storyboardId: id }).strict(),
  z.object({ type: z.literal("REORDER"), order: z.array(ref).min(1).max(MAX_SHOTS) }).strict(),
]);
export const revisionPreviewRequestSchema = z.object({ schemaVersion: z.literal(1), revisionId: z.string().uuid(),
  projectId: id, scriptId: id, revisionKey: z.literal(definition.revisionKey),
  changeSet: z.object({ operations: z.array(operation).min(1).max(MAX_OPERATIONS) }).strict() }).strict();
type Request = z.infer<typeof revisionPreviewRequestSchema>;
type Snapshot = ReturnType<typeof storyboardSemanticV2Snapshot>;
const reject = (code: string, message: string, status = 409): never => { throw new ProfileError(code, message, status); };
const tooLarge = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8") > MAX_BYTES;
const keyOf = (value: any) => value.clientRef === undefined ? `id:${value.storyboardId ?? value.id}` : `new:${value.clientRef}`;
export function normalizedChangeSet(request: Request) {
  const normalizeFields = (fields: any) => ({ ...fields,
    ...(fields.referenceAssetIds === undefined ? {} : { referenceAssetIds: [...fields.referenceAssetIds].sort((a, b) => a - b) }),
    ...(fields.linkedAssetIds === undefined ? {} : { linkedAssetIds: [...fields.linkedAssetIds].sort((a, b) => a - b) }),
    ...(fields.referenceAssetGroupIds === undefined ? {} : { referenceAssetGroupIds: [...fields.referenceAssetGroupIds].sort() }) });
  return { operations: request.changeSet.operations.map(op => op.type === "EDIT" ? { ...op, patch: normalizeFields(op.patch) } :
    op.type === "ADD" ? { ...op, storyboard: normalizeFields(op.storyboard) } : op) };
}
const safeSource = (context: Awaited<ReturnType<typeof captureStoryboardImageSourceContext>>,
  scope: { projectId: number; scriptId: number; storyboardId: number }, row?: any, links?: number[]) => {
  try {
    const value = storyboardImageSourceFromContext(context, scope, row, links);
    return { sourceHash: value.sourceHash, snapshot: value.snapshot, unavailableCode: null };
  } catch (error: any) {
    return { sourceHash: null, snapshot: null, unavailableCode: error?.code ?? "PRODUCTION_SOURCE_UNAVAILABLE" };
  }
};

async function capture(q: Knex.Transaction, request: Request) {
  const { projectId, scriptId } = request;
  const script = await q("o_script").where({ id: scriptId, projectId }).first();
  if (!script) reject("REVISION_SCOPE_INVALID", "制作单元不属于当前项目", 404);
  const revisionEpoch = Number(script.revisionEpoch ?? 0);
  if (!Number.isSafeInteger(revisionEpoch) || revisionEpoch < 0) reject("REVISION_CONTEXT_INVALID", "制作单元修订代次无效");
  const profile = await resolveProfile({ projectId }, q);
  if (!profile.managed) throw new ProfileError("REVISION_UNSUPPORTED", "当前项目没有精确 Production Profile", 409);
  const owner = profile.definition.stages.find(stage => stage.stageKey === definition.ownerStageKey);
  const reviews = profile.definition.stages.flatMap(stage => {
    if (!stage.exitGateKey) return [];
    try { const configured = reviewForGate(stage.exitGateKey);
      return configured.targetAdapterKey === definition.targetAdapterKey ? [{ stage, configured }] : []; }
    catch { return []; }
  });
  if (!owner || reviews.length !== 1) throw new ProfileError("REVISION_UNSUPPORTED", "当前精确 Profile 未唯一配置 Storyboard Semantic V2 审核", 409);
  const reviewStage = reviews[0].stage, review = reviews[0].configured;
  const outgoing = new Map(profile.definition.stages.map(stage => [stage.stageKey, [] as string[]]));
  for (const edge of profile.definition.transitions) outgoing.get(edge.fromStageKey)!.push(edge.toStageKey);
  const descendants = new Set<string>(), pending = [...outgoing.get(definition.ownerStageKey)!];
  while (pending.length) { const next = pending.shift()!; if (descendants.has(next)) continue; descendants.add(next); pending.push(...outgoing.get(next)!); }
  if (!descendants.has(reviewStage.stageKey)) reject("REVISION_UNSUPPORTED", "审核 Stage 不在 Storyboard owner 的后继图中");
  const stageKeys = new Set([definition.ownerStageKey, ...descendants]);
  const profileVersion = versionNumber(profile.version);
  const stageRuns = await q("o_stageRun").where({ projectId, scriptId, profileKey: profile.profileKey, profileVersion }).orderBy("stageKey", "asc");
  if (stageRuns.length > profile.definition.stages.length || stageRuns.some(row => !profile.definition.stages.some(s => s.stageKey === row.stageKey) ||
    !["PENDING", "IN_PROGRESS", "COMPLETED", "SKIPPED"].includes(row.state))) {
    reject("REVISION_CONTEXT_INVALID", "StageRun 与精确 Profile 不一致");
  }
  const event = await q("o_stageEvent").where({ projectId, scriptId, profileKey: profile.profileKey, profileVersion })
    .whereIn("stageKey", [...stageKeys]).orderBy("id", "desc").first("id");
  const binding = await q("o_projectProfileBinding").where({ projectId }).first();
  const recipeBinding = await q("o_projectRecipeBinding").where({ projectId }).first();
  let recipe: any = null;
  let recipeDefinition: ReturnType<typeof validateRecipeDefinition> | null = null;
  if (recipeBinding) {
    const exact = await q("o_recipeVersion").where({ recipeKey: recipeBinding.recipeKey, version: recipeBinding.recipeVersion }).first();
    if (!exact) reject("REVISION_CONTEXT_INVALID", "精确 Recipe 版本不存在");
    const parsed = validateRecipeDefinition(JSON.parse(exact.definition));
    if (recipeHash(parsed) !== exact.definitionHash || exact.definitionHash !== recipeBinding.recipeDefinitionHash ||
      parsed.profileRef.profileKey !== profile.profileKey || parsed.profileRef.profileVersion !== profile.version || !profile.persisted) {
      reject("REVISION_CONTEXT_INVALID", "Recipe 与精确 Profile 不一致");
    }
    recipe = { key: recipeBinding.recipeKey, version: recipeBinding.recipeVersion, definitionHash: exact.definitionHash,
      bindingUpdatedAt: recipeBinding.updatedAt };
    recipeDefinition = parsed;
  }
  const rows = await q("o_storyboard").where({ projectId, scriptId }).whereNull("retiredAt").orderBy("index", "asc").orderBy("id", "asc");
  if (rows.length > MAX_SHOTS) reject("REVISION_SNAPSHOT_TOO_LARGE", "分镜数量超过 Preview 上限");
  const links = rows.length ? await q("o_assets2Storyboard").whereIn("storyboardId", rows.map(row => row.id)).select("storyboardId", "assetId") : [];
  if (links.length > MAX_SHOTS * 200) reject("REVISION_SNAPSHOT_TOO_LARGE", "素材关联过多");
  const byShot = new Map<number, number[]>();
  for (const link of links) { const list = byShot.get(Number(link.storyboardId)) ?? []; list.push(Number(link.assetId)); byShot.set(Number(link.storyboardId), list); }
  const semantic = storyboardSemanticV2Snapshot(rows, byShot);
  const requestedAssets = new Set<number>();
  for (const shot of semantic) for (const assetId of [...shot.linkedAssetIds, ...shot.referenceAssetIds, ...(shot.primaryAssetId ? [shot.primaryAssetId] : [])]) requestedAssets.add(assetId);
  for (const op of request.changeSet.operations) {
    const data: any = op.type === "ADD" ? op.storyboard : op.type === "EDIT" ? op.patch : null;
    if (data) for (const assetId of [...(data.linkedAssetIds ?? []), ...(data.referenceAssetIds ?? []), ...(data.primaryAssetId ? [data.primaryAssetId] : [])]) requestedAssets.add(assetId);
  }
  if (requestedAssets.size > MAX_SHOTS * 3) reject("REVISION_SNAPSHOT_TOO_LARGE", "素材引用过多");
  const scopedAssets = requestedAssets.size ? await q("o_assets").where({ projectId }).whereIn("id", [...requestedAssets]).select("id", "scriptId") : [];
  const scriptAssets = requestedAssets.size ? await q("o_scriptAssets").where({ scriptId }).whereIn("assetId", [...requestedAssets]).select("assetId") : [];
  const plans = requestedAssets.size && profile.profileKey === "advertisement" ?
    await q("o_advertisementAssetPlan").where({ projectId, scriptId }).whereIn("assetId", [...requestedAssets]).select("assetId") : [];
  const pointerIds = [...new Set(rows.flatMap(row => [row.currentImageAttemptId, row.activeImageAttemptId]).filter(Boolean))];
  const pointerAttempts = pointerIds.length ? await q("o_productionAttempt").whereIn("attemptId", pointerIds).orderBy("attemptId", "asc") : [];
  const currentPointerIds = new Set(rows.map(row => row.currentImageAttemptId).filter(Boolean));
  const capabilityEvidence = await loadCurrentCapabilityEvidence(q, pointerAttempts.filter(row => currentPointerIds.has(row.attemptId)));
  const activeAttempts = await q("o_productionAttempt").where({ projectId, scriptId, status: "RUNNING" }).orderBy("attemptId", "asc").limit(MAX_ATTEMPTS + 1);
  if (activeAttempts.length > MAX_ATTEMPTS) reject("REVISION_SNAPSHOT_TOO_LARGE", "进行中的生产任务过多");
  const byAttempt = new Map(pointerAttempts.map(row => [row.attemptId, row]));
  for (const shot of rows) for (const [kind, pointer] of [["current", shot.currentImageAttemptId], ["active", shot.activeImageAttemptId]] as const) if (pointer) {
    const attempt = byAttempt.get(pointer);
    if (!attempt || attempt.projectId !== projectId || attempt.scriptId !== scriptId ||
      attempt.subjectType !== "STORYBOARD_IMAGE" || attempt.subjectId !== shot.id ||
      attempt.status !== (kind === "current" ? "SUCCEEDED" : "RUNNING")) {
      reject("REVISION_CONTEXT_INVALID", "分镜图片 Attempt 所有权与当前制作单元不一致");
    }
  }
  if (activeAttempts.some(row => row.profileKey !== profile.profileKey || Number(row.profileVersion) !== profileVersion ||
    !profile.definition.stages.some(stage => stage.stageKey === row.stageKey))) {
    reject("REVISION_CONTEXT_INVALID", "进行中的 Attempt 与精确 Profile 不一致");
  }
  if (activeAttempts.some(row => row.subjectType === "STORYBOARD_IMAGE" &&
    !rows.some(shot => shot.id === row.subjectId && shot.activeImageAttemptId === row.attemptId))) {
    reject("REVISION_CONTEXT_INVALID", "进行中的图片 Attempt 没有当前镜头所有权");
  }
  const reviewEvidence = await q("o_supervisorReview").where({ projectId, scriptId, reviewKey: review.reviewKey })
    .orderBy("createdAt", "desc").orderBy("reviewId", "desc")
    .first("reviewId", "targetHash", "controlContextHash", "decision", "source", "createdAt");
  // EDIT/ADD can introduce a Registry producer absent from every persisted AI
  // row. Resolve those IDs with the same D-C selector before the one bounded
  // Source-context prefetch; the canonical Source builder remains shared.
  const proposedRegistryIds = new Set<string>();
  const persistedById = new Map(rows.map(row => [Number(row.id), row]));
  for (const op of request.changeSet.operations) {
    if (op.type !== "EDIT" && op.type !== "ADD") continue;
    const persisted = op.type === "EDIT" ? persistedById.get(op.storyboardId) : null;
    if (op.type === "EDIT" && !persisted) continue; // plan() rejects the invalid target.
    const currentSpec = persisted ? productionSpec(persisted) : null;
    const proposedMode = op.type === "ADD" ? op.storyboard.productionMode : op.patch.productionMode ?? currentSpec?.productionMode ?? null;
    const selected = resolveEffectiveImageCapability(currentSpec?.capabilityId ?? null, proposedMode, recipeDefinition);
    if (proposedMode === "AI_TEXT_TO_IMAGE" && isRegistryImageSelection(selected) && selected.capabilityId)
      proposedRegistryIds.add(selected.capabilityId);
  }
  const sourceContext = await captureStoryboardImageSourceContext(q, projectId, scriptId, rows.map(row => row.id),
    [...requestedAssets], [...proposedRegistryIds]);
  const result = { projectId, scriptId, revisionEpoch, profile: { key: profile.profileKey, version: profile.version, source: profile.source,
      persisted: profile.persisted, definitionHash: definitionHash(profile.definition), bindingUpdatedAt: binding?.updatedAt ?? null,
      definition: profile.definition }, recipe, ownerStageKey: definition.ownerStageKey, descendants: [...descendants].sort(),
    stageKeys, stageRuns, lastStageEventId: event?.id ?? null, reviewEvidence, rows, semantic, byShot,
    scopedAssets, scriptAssets, plans, pointerAttempts, activeAttempts, sourceContext, capabilityEvidence };
  if (tooLarge({ ...result, sourceContext: undefined, stageKeys: undefined })) reject("REVISION_SNAPSHOT_TOO_LARGE", "Preview 快照过大");
  return result;
}

function plan(request: Request, captured: Awaited<ReturnType<typeof capture>>) {
  const original = captured.semantic;
  const active = original.map(row => ({ ...row })) as any[];
  const byId = new Map(active.map(row => [row.id, row]));
  const originalRows = new Map(captured.rows.map(row => [Number(row.id), row]));
  // B1 normalizes for review hashing (notably null index -> 0). B2 must see
  // original storage values except for fields explicitly changed by this plan.
  const proposedRows = new Map(captured.rows.map(row => [Number(row.id), { ...row }]));
  const changed = new Set<number>(), retired = new Set<number>(), clientRefs = new Set<string>();
  let reorder: any[] | null = null;
  for (const op of request.changeSet.operations) {
    if (op.type === "EDIT") {
      if (!byId.has(op.storyboardId) || changed.has(op.storyboardId) || retired.has(op.storyboardId)) reject("REVISION_CHANGE_INVALID", "EDIT 目标不存在、重复或已退休");
      if (op.patch.referenceAssetGroupIds?.length && sha256(op.patch.referenceAssetGroupIds) !== sha256(byId.get(op.storyboardId)!.referenceAssetGroupIds)) {
        reject("REVISION_UNSUPPORTED", "当前没有可验证归属的 Asset Group，不能增加或更换组引用");
      }
      Object.assign(byId.get(op.storyboardId)!, op.patch); changed.add(op.storyboardId);
      const storage = proposedRows.get(op.storyboardId)!;
      for (const field of ["track", "duration", "prompt", "videoDesc"] as const) {
        if (Object.hasOwn(op.patch, field)) storage[field] = op.patch[field] as never;
      }
      const specFields = ["productionMode", "primaryAssetId", "referenceAssetIds", "referenceAssetGroupIds"] as const;
      if (specFields.some(field => Object.hasOwn(op.patch, field))) {
        const spec = productionSpec(storage);
        storage.productionSpec = JSON.stringify({ ...spec, ...Object.fromEntries(specFields
          .filter(field => Object.hasOwn(op.patch, field)).map(field => [field, op.patch[field]])) });
      }
    } else if (op.type === "RETIRE") {
      if (!byId.has(op.storyboardId) || changed.has(op.storyboardId) || retired.has(op.storyboardId)) reject("REVISION_CHANGE_INVALID", "RETIRE 目标不存在、重复或冲突");
      retired.add(op.storyboardId);
      active.splice(active.findIndex(row => row.id === op.storyboardId), 1);
    } else if (op.type === "ADD") {
      if (clientRefs.has(op.clientRef)) reject("REVISION_CHANGE_INVALID", "ADD clientRef 重复");
      if (op.storyboard.referenceAssetGroupIds.length) reject("REVISION_UNSUPPORTED", "当前没有可验证归属的 Asset Group，不能新增组引用");
      clientRefs.add(op.clientRef);
      const { index, ...fields } = op.storyboard;
      const nextIndex = active.length ? Math.max(...active.map(row => row.index)) + 1 : 0;
      active.push({ clientRef: op.clientRef, index: index ?? nextIndex, ...fields });
    } else {
      if (reorder) reject("REVISION_CHANGE_INVALID", "一个 Preview 只能包含一次完整 REORDER");
      reorder = op.order;
    }
  }
  if (active.length > MAX_SHOTS) reject("REVISION_SNAPSHOT_TOO_LARGE", "拟议分镜数量超过上限");
  if (new Set(active.map(row => row.index)).size !== active.length) {
    reject("REVISION_CHANGE_INVALID", "显式 ADD index 与现有或先前 ADD index 冲突");
  }
  if (reorder) {
    const expected = new Set(active.map(keyOf)), actual = reorder.map(keyOf);
    if (actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some(key => !expected.has(key))) {
      reject("REVISION_CHANGE_INVALID", "REORDER 必须包含所有且仅包含拟议保留的分镜");
    }
    const slots = active.map(row => row.index).sort((a, b) => a - b);
    const lookup = new Map(active.map(row => [keyOf(row), row]));
    active.length = 0;
    for (const [position, key] of actual.entries()) {
      const row = lookup.get(key)!; row.index = slots[position]; active.push(row);
      if (row.id && row.index !== original.find(before => before.id === row.id)!.index) {
        proposedRows.get(row.id)!.index = row.index;
        changed.add(row.id);
      }
    }
  }
  active.sort((a, b) => a.index - b.index || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const beforeHash = sha256(original);
  const proposed = active.map(row => ({
    ...(row.id === undefined ? { clientRef: row.clientRef } : { id: row.id }),
    index: row.index, track: row.track, duration: row.duration, prompt: row.prompt, videoDesc: row.videoDesc,
    productionMode: row.productionMode, primaryAssetId: row.primaryAssetId,
    referenceAssetIds: [...row.referenceAssetIds].sort((a, b) => a - b),
    referenceAssetGroupIds: [...row.referenceAssetGroupIds].sort(),
    linkedAssetIds: [...row.linkedAssetIds].sort((a, b) => a - b),
  }));
  const proposedHash = sha256(proposed);
  if (beforeHash === proposedHash) reject("REVISION_NO_OP", "拟议修改没有改变 Storyboard 语义");
  const allowedAssets = new Set(captured.scopedAssets.filter(asset => asset.scriptId == null || asset.scriptId === request.scriptId).map(asset => Number(asset.id)));
  const linked = new Set(captured.scriptAssets.map(row => Number(row.assetId)));
  const planned = new Set(captured.plans.map(row => Number(row.assetId)));
  for (const row of proposed) {
    if (!Number.isFinite(row.duration) || row.duration <= 0) reject("REVISION_CHANGE_INVALID", "拟议时长无效");
    const ids = [...row.linkedAssetIds, ...row.referenceAssetIds, ...(row.primaryAssetId ? [row.primaryAssetId] : [])];
    if (ids.some(assetId => !allowedAssets.has(assetId) || !linked.has(assetId) ||
      captured.profile.key === "advertisement" && !planned.has(assetId))) reject("REVISION_ASSET_SCOPE_INVALID", "素材不属于当前制作单元的有效绑定");
  }
  const state = new Map(captured.stageRuns.map(row => [row.stageKey, row]));
  const protectedChange = [captured.ownerStageKey, ...captured.descendants].some(key =>
    key === captured.ownerStageKey ? ["COMPLETED", "SKIPPED"].includes(state.get(key)?.state ?? "PENDING") :
      (state.get(key)?.state ?? "PENDING") !== "PENDING") ||
    !!captured.reviewEvidence || captured.rows.some(row => !!row.filePath || !!row.currentImageAttemptId || !!row.activeImageAttemptId) ||
    captured.activeAttempts.some(row => captured.stageKeys.has(row.stageKey));
  const transitions: any[] = [];
  for (const key of [captured.ownerStageKey, ...captured.descendants]) {
    const row = state.get(key);
    const fromState = row?.state ?? "PENDING";
    const toState = key === captured.ownerStageKey ?
      (fromState === "COMPLETED" || fromState === "SKIPPED" ? "IN_PROGRESS" : fromState) :
      (fromState === "PENDING" ? "PENDING" : "PENDING");
    if (toState !== fromState) transitions.push({ stageKey: key, fromState, toState, eventType: key === captured.ownerStageKey ? "REOPEN" : "INVALIDATE" });
  }
  const attempts = new Map(captured.pointerAttempts.map(row => [row.attemptId, row]));
  const affectedActiveAttempts = captured.activeAttempts.filter(row => captured.stageKeys.has(row.stageKey))
    .map(row => ({ attemptId: row.attemptId, stageKey: row.stageKey, subjectType: row.subjectType, subjectId: row.subjectId, status: row.status }));
  const byProposedId = new Map(proposed.filter((row: any) => row.id !== undefined).map((row: any) => [row.id, row]));
  const outputImpact: any[] = [];
  const sourceEvidence: any[] = [];
  const warnings: string[] = [];
  if (affectedActiveAttempts.some(row => row.subjectType !== "STORYBOARD_IMAGE")) warnings.push("非图片异步任务缺少 B2 图片级保护；后续 Confirm 必须单独阻断或验证");
  for (const before of original) {
    const oldRow: any = originalRows.get(before.id)!;
    const scope = { projectId: request.projectId, scriptId: request.scriptId, storyboardId: before.id };
    const current = safeSource(captured.sourceContext, scope);
    const after: any = byProposedId.get(before.id);
    let proposedSource: ReturnType<typeof safeSource> | null = null;
    if (after) {
      proposedSource = safeSource(captured.sourceContext, scope, proposedRows.get(before.id), after.linkedAssetIds);
    }
    const attempt: any = oldRow.currentImageAttemptId ? attempts.get(oldRow.currentImageAttemptId) : null;
    const beforeFreshness = assessCurrentImageOutput(oldRow, attempt, current.sourceHash, captured.capabilityEvidence.byId).freshness;
    const afterFreshness = after ? !proposedSource?.sourceHash ? "UNKNOWN" :
      assessCurrentImageOutput(oldRow, attempt, proposedSource.sourceHash, captured.capabilityEvidence.byId).freshness : "UNKNOWN";
    if (afterFreshness === "UNKNOWN" || afterFreshness === "LEGACY") warnings.push(`镜头 ${before.id} 的既有输出不可证明可复用`);
    sourceEvidence.push({ storyboardId: before.id, currentSourceHash: current.sourceHash, proposedSourceHash: proposedSource?.sourceHash ?? null,
      currentUnavailableCode: current.unavailableCode, proposedUnavailableCode: proposedSource?.unavailableCode ?? null });
    outputImpact.push({ storyboardId: before.id, retired: !after, preservedFilePath: oldRow.filePath ?? null,
      currentAttemptId: oldRow.currentImageAttemptId ?? null, activeAttemptId: oldRow.activeImageAttemptId ?? null,
      beforeFreshness, afterFreshness, sourceChanged: !!after && current.sourceHash !== proposedSource?.sourceHash,
      currentSourceHash: current.sourceHash, proposedSourceHash: proposedSource?.sourceHash ?? null,
      sourceAssessment: proposedSource?.unavailableCode ?? current.unavailableCode,
      authorizationAffected: transitions.length > 0 && captured.stageKeys.has(attempt?.stageKey) });
  }
  for (const row of proposed) if ("clientRef" in row) outputImpact.push({ clientRef: row.clientRef, retired: false,
    preservedFilePath: null, currentAttemptId: null, activeAttemptId: null, beforeFreshness: "NONE", afterFreshness: "NONE",
    sourceChanged: null, authorizationAffected: false });
  const resolvedProfile = { key: captured.profile.key, version: captured.profile.version, definitionHash: captured.profile.definitionHash,
    source: captured.profile.source, persisted: captured.profile.persisted };
  const impact = { ownerStageKey: captured.ownerStageKey, protectedChange, descendantStageKeys: captured.descendants,
    stageTransitions: transitions, affectedActiveAttempts, outputImpact, warnings: [...new Set(warnings)] };
  const provenanceEvidence = {
    projectImageSettings: { imageQuality: captured.sourceContext.project.imageQuality ?? null,
      videoRatio: captured.sourceContext.project.videoRatio ?? null, imageModel: captured.sourceContext.project.imageModel ?? null },
    imageModel: captured.sourceContext.imageModel,
    assets: [...captured.sourceContext.assets.entries()].sort(([a], [b]) => a - b),
    plans: [...captured.sourceContext.plans.entries()].sort(([a], [b]) => a - b),
    images: [...captured.sourceContext.images.entries()].sort(([a], [b]) => a - b),
    receipts: [...captured.sourceContext.receipts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    executionRows: captured.rows.map(row => ({ id: row.id, productionSpec: row.productionSpec, imagePrompt: row.imagePrompt,
      filePath: row.filePath, state: row.state, currentImageAttemptId: row.currentImageAttemptId, activeImageAttemptId: row.activeImageAttemptId })),
  };
  const hashInput = { schemaVersion: 1, revisionKey: definition.revisionKey, scope: { projectId: request.projectId, scriptId: request.scriptId },
    changeSet: normalizedChangeSet(request), sourceTargetHash: beforeHash, proposedSemanticHash: proposedHash, currentSemantic: original,
    proposedSemantic: proposed, profile: captured.profile, recipe: captured.recipe,
    stageRuns: captured.stageRuns.filter(row => captured.stageKeys.has(row.stageKey)),
    lastStageEventId: captured.lastStageEventId, reviewEvidence: captured.reviewEvidence,
    pointerAttempts: captured.pointerAttempts, activeAttempts: captured.activeAttempts.filter(row => captured.stageKeys.has(row.stageKey)),
    sourceEvidence, capabilityExecutionEvidence: captured.capabilityEvidence.projection, provenanceEvidence, impact };
  if (tooLarge(hashInput)) reject("REVISION_SNAPSHOT_TOO_LARGE", "Preview 影响证据过大");
  return { schemaVersion: 1, revisionId: request.revisionId, revisionKey: definition.revisionKey,
    baseRevisionEpoch: captured.revisionEpoch,
    previewHash: sha256(hashInput), sourceTargetHash: beforeHash, proposedSemanticHash: proposedHash,
    targetAdapterKey: definition.targetAdapterKey,
    profile: resolvedProfile, recipe: captured.recipe, proposedSemantic: proposed, ...impact };
}

export async function captureRevisionPlan(q: Knex.Transaction, input: unknown) {
  if (tooLarge(input)) reject("REVISION_REQUEST_TOO_LARGE", "Preview 请求过大", 413);
  const parsed = revisionPreviewRequestSchema.safeParse(input);
  if (!parsed.success) reject("REVISION_CHANGE_INVALID", "Revision Preview 请求字段不合法", 400);
  const request = parsed.data!;
  positiveId(request.projectId); positiveId(request.scriptId);
  const captured = await capture(q, request);
  return { request, captured, preview: plan(request, captured) };
}

export async function previewRevision(input: unknown) {
  // All database reads (including B2 provenance) share this one SQLite snapshot.
  return db().transaction(async q => (await captureRevisionPlan(q, input)).preview);
}

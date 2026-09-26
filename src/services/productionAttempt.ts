import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import u from "@/utils";
import { ProductionGateError } from "@/services/advertisementGate";
import { resolveModelsInTransaction, requireModel } from "@/services/modelPreset";
import { readProductionOperationAdmission, type OperationAdmission } from "@/services/orchestrator/productionOperationGuard";
import { canonicalJson, sha256 } from "@/services/supervisor/contract";
import { effectiveImagePrompt, productionSpec } from "@/services/storyboardProduction";

const database = () => u.db as Knex;
const operationKey = "storyboard.image.generate";
const subjectType = "STORYBOARD_IMAGE";
const adapterKey = "storyboard.image-source.v1";
const directRef = "toonflow.real-asset-direct.v1";
type Scope = { projectId: number; scriptId: number; storyboardId: number };
type Output = { filePath: string; mediaType: string; outputHash?: string; assetId?: number; imageId?: number; assetKey?: string };

function fail(code: string, message: string): never { throw new ProductionGateError(message, code, 409); }
function parseJson(value: string | null | undefined) { return value ? JSON.parse(value) : null; }
function stableControl(admission: OperationAdmission) {
  return {
    profile: { key: admission.profileKey, version: admission.profileVersion, definitionHash: admission.profileDefinitionHash },
    recipe: admission.recipeKey ? { key: admission.recipeKey, version: admission.recipeVersion, definitionHash: admission.recipeDefinitionHash } : null,
    operationKey, stage: { key: admission.stageKey, state: admission.stageState },
    gates: admission.gates.map(gate => {
      const detail = (gate.result.details ?? gate.result) as any;
      return { gateKey: gate.gateKey, stageKey: gate.stageKey, boundary: gate.boundary, pass: gate.result.pass, code: gate.result.code,
        ...(detail && "reviewKey" in detail ? { supervisor: { reviewKey: detail.reviewKey ?? null, targetHash: detail.targetHash ?? null,
          controlContextHash: detail.controlContextHash ?? null, effectiveDecision: detail.effectiveDecision ?? null, reviewId: detail.reviewId ?? null } } : {}) };
    }),
  };
}

type SourceContext = {
  rows: Map<number, any>;
  links: Map<number, number[]>;
  plans: Map<number, any>;
  assets: Map<number, any>;
  scriptAssetIds: Set<number>;
  images: Map<number, any>;
  receipts: Map<string, any>;
  project: any;
  imageModel: string | null;
};
const receiptKey = (assetId: number, imageId: number, filePath: string) => `${assetId}:${imageId}:${filePath}`;

// One transaction-local query set for one or many shots. The canonical builder
// below is shared by begin, postflight and read-only freshness.
async function loadStoryboardImageSourceContext(q: Knex.Transaction, projectId: number, scriptId: number, ids: number[]): Promise<SourceContext> {
  const rows = await q("o_storyboard").where({ projectId, scriptId }).whereIn("id", ids);
  const project = await q("o_project").where({ id: projectId }).first();
  if (!project) fail("PRODUCTION_CONTEXT_INVALID", "项目不存在");
  const links = new Map<number, number[]>();
  if (rows.length) for (const link of await q("o_assets2Storyboard").whereIn("storyboardId", rows.map(row => row.id)).select("storyboardId", "assetId")) {
    const list = links.get(link.storyboardId) ?? [];
    list.push(link.assetId);
    links.set(link.storyboardId, list);
  }
  const directIds = new Set<number>();
  let hasAi = false;
  for (const row of rows) {
    try {
      const spec = productionSpec(row);
      if (spec.productionMode === "REAL_ASSET_DIRECT" && spec.primaryAssetId) directIds.add(spec.primaryAssetId);
      if (spec.productionMode === "AI_TEXT_TO_IMAGE") hasAi = true;
    } catch { /* The per-shot canonical builder will fail this row closed. */ }
  }
  const imageModel = hasAi ? (await resolveModelsInTransaction(projectId, q, project)).models.image : null;
  const plans = new Map<number, any>(), assets = new Map<number, any>(), scriptAssetIds = new Set<number>();
  const images = new Map<number, any>(), receipts = new Map<string, any>();
  if (directIds.size) {
    const assetIds = [...directIds];
    for (const plan of await q("o_advertisementAssetPlan").where({ projectId, scriptId }).whereIn("assetId", assetIds)) {
      if (!plans.has(plan.assetId)) plans.set(plan.assetId, plan);
    }
    for (const asset of await q("o_assets").where({ projectId }).whereIn("id", assetIds)) assets.set(asset.id, asset);
    for (const link of await q("o_scriptAssets").where({ scriptId }).whereIn("assetId", assetIds).select("assetId")) scriptAssetIds.add(link.assetId);
    const imageIds = [...new Set([...assets.values()].map(asset => asset.imageId).filter((id): id is number => id != null))];
    if (imageIds.length) for (const image of await q("o_image").whereIn("id", imageIds)) images.set(image.id, image);
    for (const receipt of await q("o_assetUploadSource").where({ projectId }).whereIn("assetId", assetIds)) {
      receipts.set(receiptKey(receipt.assetId, receipt.imageId, receipt.filePath), receipt);
    }
  }
  return { rows: new Map(rows.map(row => [row.id, row])), links, plans, assets, scriptAssetIds, images, receipts, project, imageModel };
}

function buildStoryboardImageSource(context: SourceContext, scope: Scope) {
  const row = context.rows.get(scope.storyboardId);
  if (!row) fail("PRODUCTION_SUBJECT_CHANGED", "当前分镜不存在或不属于该制作单元");
  const spec = productionSpec(row);
  if (spec.productionMode !== "REAL_ASSET_DIRECT" && spec.productionMode !== "AI_TEXT_TO_IMAGE") fail("CAPABILITY_INPUT_UNSUPPORTED", "当前生产方式不属于图片生成 Attempt V1");
  const linkedAssetIds = [...(context.links.get(row.id) ?? [])].sort((a, b) => a - b);
  const semantic = { id: row.id, index: row.index ?? null, track: row.track ?? null, duration: row.duration == null ? null : Number(row.duration),
    prompt: row.prompt ?? "", videoDesc: row.videoDesc ?? null, productionMode: spec.productionMode,
    primaryAssetId: spec.primaryAssetId, referenceAssetIds: [...spec.referenceAssetIds].sort((a, b) => a - b),
    referenceAssetGroupIds: [...spec.referenceAssetGroupIds].sort(), linkedAssetIds };
  let execution: any;
  let producerType: string;
  let producerRef: string | null;
  let producerInput: any;
  if (spec.productionMode === "REAL_ASSET_DIRECT") {
    if (!spec.primaryAssetId) fail("PRIMARY_ASSET_REQUIRED", "真实素材直用必须指定主素材");
    if (spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) fail("CAPABILITY_INPUT_UNSUPPORTED", "真实素材直用不消费参考输入");
    if (spec.capabilityId && spec.capabilityId !== directRef) fail("CAPABILITY_NOT_IMPLEMENTED", "当前直出能力不可用");
    const plan = context.plans.get(spec.primaryAssetId);
    if (!plan || plan.sourcePolicy !== "REAL_REQUIRED") fail("PRIMARY_ASSET_INVALID", "主素材不是当前单元有效的真实素材计划绑定");
    const asset = context.assets.get(spec.primaryAssetId);
    if (!asset || !context.scriptAssetIds.has(spec.primaryAssetId) || asset.scriptId != null && asset.scriptId !== scope.scriptId) {
      fail("PRIMARY_ASSET_INVALID", "主素材不属于当前制作单元");
    }
    const image = asset.imageId == null ? null : context.images.get(asset.imageId);
    if (!image?.filePath || image.assetsId !== asset.id || image.state !== "已完成" || image.model) fail("PRIMARY_ASSET_INVALID", "真实主素材当前图片或上传来源无效");
    const receipt = context.receipts.get(receiptKey(asset.id, image.id, image.filePath));
    if (!receipt) fail("PRIMARY_ASSET_INVALID", "真实主素材上传来源凭据已失效");
    execution = { capabilityId: spec.capabilityId ?? directRef, asset: { assetId: asset.id, imageId: image.id, filePath: image.filePath,
      assetKey: plan.assetKey, sourcePolicy: plan.sourcePolicy, uploadedAt: receipt.uploadedAt } };
    producerType = "REAL_ASSET_DIRECT"; producerRef = directRef;
    producerInput = execution.asset;
  } else {
    if (spec.primaryAssetId !== null || spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) fail("CAPABILITY_INPUT_UNSUPPORTED", "纯文生图不接受真实主素材或参考输入");
    if (spec.capabilityId && spec.capabilityId !== "toonflow.image.v1") fail("CAPABILITY_NOT_IMPLEMENTED", "当前图片能力不可用");
    const project = context.project;
    const model = context.imageModel;
    execution = { imagePrompt: row.imagePrompt ?? null, promptSkillId: spec.promptSkillId, promptSkillVersion: spec.promptSkillVersion,
      capabilityId: spec.capabilityId ?? "toonflow.image.v1", imageModel: model,
      imageQuality: project?.imageQuality ?? null, videoRatio: project?.videoRatio ?? null };
    producerType = "AI_MODEL"; producerRef = model;
    producerInput = { prompt: effectiveImagePrompt(row), model, size: execution.imageQuality, aspectRatio: execution.videoRatio };
  }
  const snapshot = { adapterKey, semantic, execution };
  return { row, snapshot, sourceHash: sha256(snapshot), producerType, producerRef, producerInput };
}

export async function captureStoryboardImageSource(q: Knex.Transaction, scope: Scope) {
  const context = await loadStoryboardImageSourceContext(q, scope.projectId, scope.scriptId, [scope.storyboardId]);
  return buildStoryboardImageSource(context, scope);
}

export async function beginStoryboardImageAttempt(scope: Scope, requestModel?: string, transaction?: Knex.Transaction) {
  const begin = async (q: Knex.Transaction) => {
    const source = await captureStoryboardImageSource(q, scope);
    if (requestModel && source.producerType === "AI_MODEL" && requestModel !== source.producerRef) fail("MODEL_CONFIG_MISMATCH", "所选模型与当前项目配置不同，请保存配置后重试");
    const admission = await readProductionOperationAdmission(operationKey, scope, q);
    if (!admission.enforced || !admission.allowed || !admission.snapshotConsistent) fail(admission.code, admission.reason ?? "当前生产工序未放行");
    const controlSnapshot = stableControl(admission);
    const now = Date.now(), attemptId = randomUUID();
    await q("o_productionAttempt").where({ projectId: scope.projectId, scriptId: scope.scriptId, subjectType, subjectId: scope.storyboardId, status: "RUNNING" })
      .update({ status: "STALE", staleCode: "PRODUCTION_ATTEMPT_SUPERSEDED", staleReason: "已有更新的图片生产任务", updatedAt: now });
    await q("o_productionAttempt").insert({ attemptId, projectId: scope.projectId, scriptId: scope.scriptId,
      profileKey: admission.profileKey, profileVersion: Number(admission.profileVersion!.slice(1)), profileDefinitionHash: admission.profileDefinitionHash,
      recipeKey: admission.recipeKey, recipeVersion: admission.recipeVersion, recipeDefinitionHash: admission.recipeDefinitionHash,
      stageKey: admission.stageKey, operationKey, subjectType, subjectId: scope.storyboardId, sourceAdapterKey: adapterKey,
      sourceHash: source.sourceHash, sourceSnapshot: canonicalJson(source.snapshot), producerType: source.producerType,
      producerRef: source.producerRef, producerInput: canonicalJson(source.producerInput), controlContextHash: sha256(controlSnapshot),
      controlSnapshot: canonicalJson(controlSnapshot), status: "RUNNING", startedAt: now, updatedAt: now });
    await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
      .update({ activeImageAttemptId: attemptId, state: "生成中", reason: "" });
    return { attemptId, ...scope, producerType: source.producerType, producerRef: source.producerRef, producerInput: source.producerInput };
  };
  return transaction ? begin(transaction) : database().transaction(begin);
}

export async function finishStoryboardImageAttempt(attemptId: string, output: Output) {
  return database().transaction(async q => {
    const attempt = await q("o_productionAttempt").where({ attemptId }).first();
    if (!attempt) fail("PRODUCTION_ATTEMPT_NOT_FOUND", "图片生产任务不存在");
    const scope = { projectId: attempt.projectId, scriptId: attempt.scriptId, storyboardId: attempt.subjectId };
    const now = Date.now(), outputRef = canonicalJson(output);
    if (attempt.status === "STALE") {
      await q("o_productionAttempt").where({ attemptId }).update({ outputRef, completedAt: now, updatedAt: now });
      return { attemptId, status: "STALE", staleCode: attempt.staleCode };
    }
    if (attempt.status !== "RUNNING") return { attemptId, status: attempt.status };
    const storyboard = await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId }).first();
    let staleCode: string | null = null;
    if (!storyboard) staleCode = "PRODUCTION_SUBJECT_CHANGED";
    else if (storyboard.activeImageAttemptId !== attemptId) staleCode = "PRODUCTION_ATTEMPT_SUPERSEDED";
    const input = parseJson(attempt.producerInput);
    if (!staleCode && (attempt.producerType === "REAL_ASSET_DIRECT" && output.filePath !== input?.filePath ||
      attempt.producerType === "AI_MODEL" && output.filePath !== `/${scope.projectId}/production-attempts/${attemptId}/image.jpg`)) staleCode = "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
    if (!staleCode) {
      try {
        const source = await captureStoryboardImageSource(q, scope);
        if (source.sourceHash !== attempt.sourceHash) staleCode = "PRODUCTION_SOURCE_CHANGED";
      } catch { staleCode = "PRODUCTION_SOURCE_CHANGED"; }
    }
    if (!staleCode) {
      const admission = await readProductionOperationAdmission(operationKey, scope, q);
      if (!admission.enforced || !admission.allowed || !admission.snapshotConsistent || sha256(stableControl(admission)) !== attempt.controlContextHash) staleCode = "PRODUCTION_CONTROL_CHANGED";
    }
    if (staleCode) {
      await q("o_productionAttempt").where({ attemptId }).update({ status: "STALE", staleCode, staleReason: "生产来源或控制状态已变化，输出仅保留在任务记录中", outputRef, completedAt: now, updatedAt: now });
      if (storyboard?.activeImageAttemptId === attemptId) await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
        .update({ activeImageAttemptId: null, state: storyboard.filePath ? "已完成" : "未生成", reason: staleCode });
      return { attemptId, status: "STALE", staleCode };
    }
    await q("o_productionAttempt").where({ attemptId }).update({ status: "SUCCEEDED", outputRef, completedAt: now, updatedAt: now });
    await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
      .update({ filePath: output.filePath, currentImageAttemptId: attemptId, activeImageAttemptId: null, state: "已完成", reason: "" });
    return { attemptId, status: "SUCCEEDED" };
  });
}

export async function failStoryboardImageAttempt(attemptId: string, error: unknown) {
  return database().transaction(async q => {
    const attempt = await q("o_productionAttempt").where({ attemptId }).first();
    if (!attempt || attempt.status !== "RUNNING") return;
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "STORYBOARD_PRODUCTION_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    await q("o_productionAttempt").where({ attemptId }).update({ status: "FAILED", errorCode: code, error: message, completedAt: Date.now(), updatedAt: Date.now() });
    const where = { id: attempt.subjectId, projectId: attempt.projectId, scriptId: attempt.scriptId, activeImageAttemptId: attemptId };
    const row = await q("o_storyboard").where(where).first();
    if (row) await q("o_storyboard").where(where).update({ activeImageAttemptId: null, state: row.filePath ? "已完成" : "生成失败", reason: row.filePath ? "" : `${code}: ${message}` });
  });
}

export async function runStoryboardImageAttempt(attempt: Awaited<ReturnType<typeof beginStoryboardImageAttempt>>) {
  try {
    let output: Output;
    if (attempt.producerType === "REAL_ASSET_DIRECT") {
      output = { filePath: attempt.producerInput.filePath, mediaType: "image/*", assetId: attempt.producerInput.assetId,
        imageId: attempt.producerInput.imageId, assetKey: attempt.producerInput.assetKey };
    } else {
      const input = attempt.producerInput;
      const model = await requireModel(attempt.projectId, "image");
      if (model !== input.model) fail("MODEL_CONFIG_MISMATCH", "生产期间图片模型配置已变化");
      const image = await u.Ai.Image(model as `${string}:${string}`).run({ prompt: input.prompt, size: input.size,
        aspectRatio: input.aspectRatio, referenceList: [] }, { taskClass: "生成分镜图片", describe: "分镜图片生成",
        relatedObjects: JSON.stringify({ storyboardId: attempt.storyboardId, scriptId: attempt.scriptId, attemptId: attempt.attemptId, ...input }), projectId: attempt.projectId });
      const filePath = `/${attempt.projectId}/production-attempts/${attempt.attemptId}/image.jpg`;
      await image.save(filePath);
      output = { filePath, mediaType: "image/jpeg" };
    }
    return finishStoryboardImageAttempt(attempt.attemptId, output);
  } catch (error) {
    await failStoryboardImageAttempt(attempt.attemptId, error);
    return { attemptId: attempt.attemptId, status: "FAILED" };
  }
}

export async function readImageProvenance(projectId: number, scriptId: number, storyboards: any[]) {
  const ids = storyboards.map(row => row.id).filter(Boolean);
  if (!ids.length) return new Map<number, any>();
  return database().transaction(async q => {
    const attempts = await q("o_productionAttempt").where({ projectId, scriptId, subjectType }).whereIn("subjectId", ids).orderBy("startedAt", "desc").orderByRaw("rowid DESC");
    const sourceContext = await loadStoryboardImageSourceContext(q, projectId, scriptId, ids);
    const byId = new Map(attempts.map(a => [a.attemptId, a]));
    const latest = new Map<number, any>();
    for (const attempt of attempts) if (!latest.has(attempt.subjectId)) latest.set(attempt.subjectId, attempt);
    const result = new Map<number, any>();
    for (const requestedRow of storyboards) {
      const row = sourceContext.rows.get(requestedRow.id) ?? requestedRow;
      const current = row.currentImageAttemptId ? byId.get(row.currentImageAttemptId) : null;
      let freshness: "NONE" | "LEGACY" | "CURRENT" | "STALE" = !row.filePath ? "NONE" : !row.currentImageAttemptId ? "LEGACY" : "STALE";
      let staleCode: string | null = null;
      if (freshness === "STALE") {
        try {
          const source = buildStoryboardImageSource(sourceContext, { projectId, scriptId, storyboardId: row.id });
          const output = parseJson(current?.outputRef);
          if (current?.status === "SUCCEEDED" && output?.filePath === row.filePath && source.sourceHash === current.sourceHash) freshness = "CURRENT";
          else staleCode = !current || output?.filePath !== row.filePath ? "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH" : "PRODUCTION_SOURCE_CHANGED";
        } catch { staleCode = "PRODUCTION_SOURCE_CHANGED"; }
      }
      result.set(row.id, { freshness, currentAttemptId: row.currentImageAttemptId ?? null, activeAttemptId: row.activeImageAttemptId ?? null,
        producerType: current?.producerType ?? null, producerRef: current?.producerRef ?? null, sourceHash: current?.sourceHash ?? null,
        staleCode, staleReason: staleCode ? "当前镜头来源与保留图片不一致" : null, latestAttemptStatus: latest.get(row.id)?.status ?? null });
    }
    return result;
  });
}

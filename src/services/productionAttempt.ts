import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import u from "@/utils";
import { readAttachCandidate } from "@/services/attachCandidate";
import { ProductionGateError } from "@/services/advertisementGate";
import { resolveModelsInTransaction, requireModel } from "@/services/modelPreset";
import { readProductionOperationAdmission, type OperationAdmission } from "@/services/orchestrator/productionOperationGuard";
import type { ProductionOperationKey } from "@/services/orchestrator/productionOperationRegistry";
import { canonicalJson, sha256 } from "@/services/supervisor/contract";
import { effectiveImagePrompt, productionSpec } from "@/services/storyboardProduction";
import { readExactRecipeRuntimeContext } from "@/services/recipeRegistry";
import { resolveEffectiveImageCapability, validateSelectedImageCapability } from "@/services/recipeImageCapability";
import { RecipeError } from "@/services/recipeContract";
import { createPinnedImageProducer, imageDimensions, isRegistryImageSelection, provenanceMismatchCode,
  readRegistryVersions, registrySourceAdapterKey, type RegistryVersion, type RegistryVersions } from "@/services/storyboardImageCapability";
import { executePinnedImageCapability, proveCapabilityImageOutput, type CapabilityImageOutput } from "@/services/executeCapability";

const database = () => u.db as Knex;
const generateOperationKey = "storyboard.image.generate";
const attachOperationKey = "storyboard.image.attach";
const subjectType = "STORYBOARD_IMAGE";
const adapterKey = "storyboard.image-source.v1";
const directRef = "toonflow.real-asset-direct.v1";
type Scope = { projectId: number; scriptId: number; storyboardId: number };
type Output = { filePath: string; mediaType: string; outputHash?: string; byteLength?: number; flowId?: number;
  candidateNodeType?: string; candidateNodeId?: string; assetId?: number; imageId?: number; assetKey?: string;
  capabilityExecutionId?: string; capabilityId?: string; definitionHash?: string; endpointId?: string;
  endpointOrigin?: string; promptId?: string; outputPort?: string };

function fail(code: string, message: string): never { throw new ProductionGateError(message, code, 409); }
function parseJson(value: string | null | undefined) { return value ? JSON.parse(value) : null; }
function stableControl(admission: OperationAdmission) {
  return {
    profile: { key: admission.profileKey, version: admission.profileVersion, definitionHash: admission.profileDefinitionHash },
    recipe: admission.recipeKey ? { key: admission.recipeKey, version: admission.recipeVersion, definitionHash: admission.recipeDefinitionHash } : null,
    operationKey: admission.operationKey, stage: { key: admission.stageKey, state: admission.stageState },
    gates: admission.gates.map(gate => {
      const detail = (gate.result.details ?? gate.result) as any;
      return { gateKey: gate.gateKey, stageKey: gate.stageKey, boundary: gate.boundary, pass: gate.result.pass, code: gate.result.code,
        ...(detail && "reviewKey" in detail ? { supervisor: { reviewKey: detail.reviewKey ?? null, targetHash: detail.targetHash ?? null,
          controlContextHash: detail.controlContextHash ?? null, effectiveDecision: detail.effectiveDecision ?? null, reviewId: detail.reviewId ?? null } } : {}) };
    }),
  };
}

export type StoryboardImageSourceContext = {
  rows: Map<number, any>;
  links: Map<number, number[]>;
  plans: Map<number, any>;
  assets: Map<number, any>;
  scriptAssetIds: Set<number>;
  images: Map<number, any>;
  receipts: Map<string, any>;
  project: any;
  imageModel: string | null;
  recipe: Awaited<ReturnType<typeof readExactRecipeRuntimeContext>>;
  registryVersions: RegistryVersions;
  registryEndpoints: Map<string, any>;
};
const receiptKey = (assetId: number, imageId: number, filePath: string) => `${assetId}:${imageId}:${filePath}`;

// One transaction-local query set for one or many shots. The canonical builder
// below is shared by begin, postflight and read-only freshness.
async function loadStoryboardImageSourceContext(q: Knex.Transaction, projectId: number, scriptId: number, ids: number[], extraPrimaryAssetIds: number[] = [], includeImageModel = false,
  extraRegistryCapabilityIds: string[] = []): Promise<StoryboardImageSourceContext> {
  const rows = await q("o_storyboard").where({ projectId, scriptId }).whereNull("retiredAt").whereIn("id", ids);
  const project = await q("o_project").where({ id: projectId }).first();
  if (!project) fail("PRODUCTION_CONTEXT_INVALID", "项目不存在");
  const recipe = await readExactRecipeRuntimeContext(q, projectId);
  const links = new Map<number, number[]>();
  if (rows.length) for (const link of await q("o_assets2Storyboard").whereIn("storyboardId", rows.map(row => row.id)).select("storyboardId", "assetId")) {
    const list = links.get(link.storyboardId) ?? [];
    list.push(link.assetId);
    links.set(link.storyboardId, list);
  }
  const directIds = new Set<number>(extraPrimaryAssetIds);
  let hasAi = false;
  const registryIds = new Set(extraRegistryCapabilityIds);
  for (const row of rows) {
    try {
      const spec = productionSpec(row);
      if ((spec.productionMode === "REAL_ASSET_DIRECT" || spec.productionMode === "REAL_AI_COMPOSITE") && spec.primaryAssetId) directIds.add(spec.primaryAssetId);
      if (spec.productionMode === "AI_TEXT_TO_IMAGE") {
        hasAi = true;
        const selected = resolveEffectiveImageCapability(spec.capabilityId, spec.productionMode, recipe);
        if (isRegistryImageSelection(selected) && selected.capabilityId) registryIds.add(selected.capabilityId);
      }
    } catch { /* The per-shot canonical builder will fail this row closed. */ }
  }
  const imageModel = hasAi || includeImageModel ? (await resolveModelsInTransaction(projectId, q, project)).models.image : null;
  const registryVersions = await readRegistryVersions(q, [...registryIds]);
  const endpointIds = [...new Set([...registryVersions.values()].filter((item): item is Exclude<typeof item, "INVALID" | null> => !!item && item !== "INVALID")
    .map(item => item.version.endpointId))];
  const registryEndpoints = new Map<string, any>(endpointIds.length ?
    (await q("o_capabilityEndpoint").whereIn("id", endpointIds)).map(row => [row.id, row]) : []);
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
    // Only the upload receipt for each asset's current image/path can affect
    // the accepted B2 source. Historical receipts are neither read nor hashed.
    for (const receipt of await q("o_assetUploadSource as receipt")
      .join("o_assets as asset", function () {
        this.on("receipt.assetId", "=", "asset.id").andOn("receipt.imageId", "=", "asset.imageId");
      })
      .join("o_image as image", function () {
        this.on("image.id", "=", "asset.imageId").andOn("receipt.filePath", "=", "image.filePath");
      })
      .where("receipt.projectId", projectId).where("asset.projectId", projectId).whereIn("receipt.assetId", assetIds)
      .select("receipt.*").limit(assetIds.length + 1)) {
      receipts.set(receiptKey(receipt.assetId, receipt.imageId, receipt.filePath), receipt);
    }
  }
  return { rows: new Map(rows.map(row => [row.id, row])), links, plans, assets, scriptAssetIds, images, receipts, project, imageModel, recipe, registryVersions, registryEndpoints };
}

function buildStoryboardImageSource(context: StoryboardImageSourceContext, scope: Scope) {
  const row = context.rows.get(scope.storyboardId);
  if (!row) fail("PRODUCTION_SUBJECT_CHANGED", "当前分镜不存在或不属于该制作单元");
  const spec = productionSpec(row);
  if (spec.productionMode !== "REAL_ASSET_DIRECT" && spec.productionMode !== "AI_TEXT_TO_IMAGE" && spec.productionMode !== "REAL_AI_COMPOSITE") fail("CAPABILITY_INPUT_UNSUPPORTED", "当前生产方式不属于图片生产 Attempt");
  const linkedAssetIds = [...(context.links.get(row.id) ?? [])].sort((a, b) => a - b);
  const semantic = { id: row.id, index: row.index ?? null, track: row.track ?? null, duration: row.duration == null ? null : Number(row.duration),
    prompt: row.prompt ?? "", videoDesc: row.videoDesc ?? null, productionMode: spec.productionMode,
    primaryAssetId: spec.primaryAssetId, referenceAssetIds: [...spec.referenceAssetIds].sort((a, b) => a - b),
    referenceAssetGroupIds: [...spec.referenceAssetGroupIds].sort(), linkedAssetIds };
  let execution: any;
  let producerType: string;
  let producerRef: string | null;
  let producerInput: any;
  let effectiveCapability: ReturnType<typeof resolveEffectiveImageCapability> | null = null;
  let registryVersion: RegistryVersion | null = null;
  let registryEndpoint: any = null;
  if (spec.productionMode === "REAL_ASSET_DIRECT" || spec.productionMode === "REAL_AI_COMPOSITE") {
    if (!spec.primaryAssetId) fail("PRIMARY_ASSET_REQUIRED", "真实素材直用必须指定主素材");
    if (spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) fail("CAPABILITY_INPUT_UNSUPPORTED", "当前真实主素材生产不消费参考输入");
    if (spec.productionMode === "REAL_ASSET_DIRECT" && spec.capabilityId && spec.capabilityId !== directRef) fail("CAPABILITY_NOT_IMPLEMENTED", "当前直出能力不可用");
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
    execution = { ...(spec.productionMode === "REAL_AI_COMPOSITE" ? { imagePrompt: row.imagePrompt ?? null,
      promptSkillId: spec.promptSkillId, promptSkillVersion: spec.promptSkillVersion } : {}),
      capabilityId: spec.capabilityId ?? (spec.productionMode === "REAL_ASSET_DIRECT" ? directRef : null),
      asset: { assetId: asset.id, imageId: image.id, filePath: image.filePath,
        assetKey: plan.assetKey, sourcePolicy: plan.sourcePolicy, uploadedAt: receipt.uploadedAt } };
    producerType = spec.productionMode; producerRef = spec.productionMode === "REAL_ASSET_DIRECT" ? directRef : null;
    producerInput = execution.asset;
  } else {
    if (spec.primaryAssetId !== null || spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) fail("CAPABILITY_INPUT_UNSUPPORTED", "纯文生图不接受真实主素材或参考输入");
    const project = context.project;
    const model = context.imageModel;
    const selected = resolveEffectiveImageCapability(spec.capabilityId, spec.productionMode, context.recipe);
    effectiveCapability = selected;
    if (isRegistryImageSelection(selected)) {
      const exact = selected.capabilityId ? context.registryVersions.get(selected.capabilityId) : null;
      if (exact === "INVALID") fail("CAPABILITY_ROLE_INCOMPATIBLE", "精确 Capability Version 定义无效");
      if (!exact) fail("CAPABILITY_NOT_FOUND", "精确 Capability Version 不存在或定义无效");
      registryVersion = exact;
      registryEndpoint = context.registryEndpoints.get(exact.version.endpointId) ?? null;
      const { width, height } = imageDimensions(project?.imageQuality ?? null, project?.videoRatio ?? null);
      execution = { imagePrompt: row.imagePrompt ?? null, promptSkillId: spec.promptSkillId, promptSkillVersion: spec.promptSkillVersion,
        capabilityId: selected.capabilityId, imageModel: null, imageQuality: project?.imageQuality ?? null,
        videoRatio: project?.videoRatio ?? null, roleAdapterKey: "storyboard-image.text-to-image", roleAdapterVersion: 1,
        width, height, capabilityDefinitionHash: exact.definitionHash };
      producerType = "CAPABILITY"; producerRef = selected.capabilityId;
      producerInput = { prompt: effectiveImagePrompt(row), width, height };
    } else {
      execution = { imagePrompt: row.imagePrompt ?? null, promptSkillId: spec.promptSkillId, promptSkillVersion: spec.promptSkillVersion,
        capabilityId: selected.capabilityId, imageModel: model,
        imageQuality: project?.imageQuality ?? null, videoRatio: project?.videoRatio ?? null };
      producerType = "AI_MODEL"; producerRef = model;
      producerInput = { prompt: effectiveImagePrompt(row), model, size: execution.imageQuality, aspectRatio: execution.videoRatio };
    }
  }
  const snapshot = { adapterKey: producerType === "CAPABILITY" ? registrySourceAdapterKey : adapterKey, semantic, execution };
  // Resolution branch is pre-write admission metadata, never part of the B2
  // canonical Source snapshot/hash or persisted Attempt sourceSnapshot.
  return { row, snapshot, sourceHash: sha256(snapshot), producerType, producerRef, producerInput, effectiveCapability,
    registryVersion, registryEndpoint };
}

export async function captureStoryboardImageSource(q: Knex.Transaction, scope: Scope) {
  const context = await loadStoryboardImageSourceContext(q, scope.projectId, scope.scriptId, [scope.storyboardId]);
  return buildStoryboardImageSource(context, scope);
}

// B3-A captures this bounded context inside its one read transaction, then
// uses the same pure B2 source builder for current/proposed in memory.
export async function captureStoryboardImageSourceContext(q: Knex.Transaction, projectId: number, scriptId: number,
  ids: number[], extraPrimaryAssetIds: number[] = [], extraRegistryCapabilityIds: string[] = []) {
  return loadStoryboardImageSourceContext(q, projectId, scriptId, ids, extraPrimaryAssetIds, true, extraRegistryCapabilityIds);
}
export function storyboardImageSourceFromContext(context: StoryboardImageSourceContext, scope: Scope, row?: any, links?: number[]) {
  if (!row && !links) return buildStoryboardImageSource(context, scope);
  const local = { ...context, rows: new Map(context.rows), links: new Map(context.links) };
  if (row) local.rows.set(scope.storyboardId, row);
  if (links) local.links.set(scope.storyboardId, links);
  return buildStoryboardImageSource(local, scope);
}

type Producer = { producerType: string; producerRef: string | null; producerInput: any };
export type CurrentImageAttemptHooks = {
  onAttemptCreated?: (q: Knex.Transaction, attemptId: string) => Promise<void>;
  preRecordOutput?: (q: Knex.Transaction, attempt: any, output: Output) => Promise<string | null>;
  validateOutput?: (q: Knex.Transaction, attempt: any, output: Output, scope: Scope) => Promise<string | null>;
  onSuccess?: (q: Knex.Transaction, attempt: any, output: Output) => Promise<void>;
  onStale?: (q: Knex.Transaction, attempt: any, output: Output | null, staleCode: string) => Promise<void>;
  onFail?: (q: Knex.Transaction, attempt: any, code: string, message: string) => Promise<void>;
};
export async function beginCurrentImageAttempt(scope: Scope, operationKey: ProductionOperationKey,
  prepareProducer: (q: Knex.Transaction, source: Awaited<ReturnType<typeof captureStoryboardImageSource>>) => Promise<Producer> | Producer,
  transaction?: Knex.Transaction, hooks: CurrentImageAttemptHooks = {}, sourceContext?: StoryboardImageSourceContext) {
  const begin = async (q: Knex.Transaction) => {
    const source = sourceContext ? buildStoryboardImageSource(sourceContext, scope) : await captureStoryboardImageSource(q, scope);
    const producer = await prepareProducer(q, source);
    const admission = await readProductionOperationAdmission(operationKey, scope, q);
    if (!admission.enforced || !admission.allowed || !admission.snapshotConsistent) fail(admission.code, admission.reason ?? "当前生产工序未放行");
    const controlSnapshot = stableControl(admission);
    const now = Date.now(), attemptId = randomUUID();
    await q("o_productionAttempt").where({ projectId: scope.projectId, scriptId: scope.scriptId, subjectType, subjectId: scope.storyboardId, status: "RUNNING" })
      .update({ status: "STALE", staleCode: "PRODUCTION_ATTEMPT_SUPERSEDED", staleReason: "已有更新的图片生产任务", updatedAt: now });
    await q("o_productionAttempt").insert({ attemptId, projectId: scope.projectId, scriptId: scope.scriptId,
      profileKey: admission.profileKey, profileVersion: Number(admission.profileVersion!.slice(1)), profileDefinitionHash: admission.profileDefinitionHash,
      recipeKey: admission.recipeKey, recipeVersion: admission.recipeVersion, recipeDefinitionHash: admission.recipeDefinitionHash,
      stageKey: admission.stageKey, operationKey, subjectType, subjectId: scope.storyboardId, sourceAdapterKey: source.snapshot.adapterKey,
      sourceHash: source.sourceHash, sourceSnapshot: canonicalJson(source.snapshot), producerType: producer.producerType,
      producerRef: producer.producerRef, producerInput: canonicalJson(producer.producerInput), controlContextHash: sha256(controlSnapshot),
      controlSnapshot: canonicalJson(controlSnapshot), status: "RUNNING", startedAt: now, updatedAt: now });
    await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
      .update({ activeImageAttemptId: attemptId, state: "生成中", reason: "" });
    await hooks.onAttemptCreated?.(q, attemptId);
    return { attemptId, ...scope, ...producer };
  };
  return transaction ? begin(transaction) : database().transaction(begin);
}

export async function beginStoryboardImageAttempt(scope: Scope, requestModel?: string, transaction?: Knex.Transaction,
  sourceContext?: StoryboardImageSourceContext) {
  return beginCurrentImageAttempt(scope, generateOperationKey, async (q, source) => {
    if (source.producerType !== "REAL_ASSET_DIRECT" && source.producerType !== "AI_MODEL" && source.producerType !== "CAPABILITY")
      fail("CAPABILITY_INPUT_UNSUPPORTED", "当前生产方式不能进入普通分镜图片生成");
    if (source.producerType === "CAPABILITY") {
      if (requestModel) fail("MODEL_CONFIG_MISMATCH", "Registry Capability 不接受旧图片模型覆盖");
      const input = source.producerInput;
      const plan = await createPinnedImageProducer(q, source.registryVersion, source.producerRef!, input.prompt, input.width, input.height,
        source.registryEndpoint);
      return { producerType: "CAPABILITY", producerRef: source.producerRef, producerInput: plan };
    }
    if (source.producerType === "AI_MODEL") {
      if (!source.effectiveCapability) fail("CAPABILITY_NOT_FOUND", "当前图片能力解析失败");
      await validateSelectedImageCapability(q, source.effectiveCapability);
    }
    if (requestModel && source.producerType === "AI_MODEL" && requestModel !== source.producerRef) fail("MODEL_CONFIG_MISMATCH", "所选模型与当前项目配置不同，请保存配置后重试");
    return { producerType: source.producerType, producerRef: source.producerRef, producerInput: source.producerInput };
  }, transaction, {}, sourceContext);
}

export async function captureStoryboardImageSourceBatch(q: Knex.Transaction, projectId: number, scriptId: number, ids: number[]) {
  return loadStoryboardImageSourceContext(q, projectId, scriptId, ids);
}

async function outputProvenanceCode(q: Knex.Transaction, attempt: any, output: Output, scope: Scope): Promise<string | null> {
  const input = parseJson(attempt.producerInput);
  if (attempt.producerType === "REAL_ASSET_DIRECT") return output.filePath === input?.filePath ? null : "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
  if (attempt.producerType === "AI_MODEL") return output.filePath === `/${scope.projectId}/production-attempts/${attempt.attemptId}/image.jpg` ? null : "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
  if (attempt.producerType === "MANUAL_ATTACH") {
    if (attempt.operationKey !== attachOperationKey || attempt.producerRef !== `imageFlow:${input?.flowId}` ||
      output.filePath !== input?.candidatePath || output.flowId !== input?.flowId || !output.outputHash || !output.byteLength) {
      return "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
    }
    try {
      const current = await readAttachCandidate(q, scope.projectId, input.flowId, input.candidatePath);
      return current.candidateNodeId === input.candidateNodeId && current.candidateNodeType === input.candidateNodeType ? null : "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
    } catch (error) { return error instanceof ProductionGateError ? error.code : "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH"; }
  }
  return "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
}

async function currentImageDrift(q: Knex.Transaction, attempt: any, storyboard: any, scope: Scope) {
  if (!storyboard) return "PRODUCTION_SUBJECT_CHANGED";
  if (storyboard.activeImageAttemptId !== attempt.attemptId) return "PRODUCTION_ATTEMPT_SUPERSEDED";
  try {
    const source = await captureStoryboardImageSource(q, scope);
    if (source.sourceHash !== attempt.sourceHash) return "PRODUCTION_SOURCE_CHANGED";
  } catch { return "PRODUCTION_SOURCE_CHANGED"; }
  const admission = await readProductionOperationAdmission(attempt.operationKey, scope, q);
  if (!admission.enforced || !admission.allowed || !admission.snapshotConsistent || sha256(stableControl(admission)) !== attempt.controlContextHash) return "PRODUCTION_CONTROL_CHANGED";
  return null;
}

export async function recheckCurrentImageAttempt(attemptId: string, hooks: CurrentImageAttemptHooks = {}, transaction?: Knex.Transaction) {
  const check = async (q: Knex.Transaction) => {
    const attempt = await q("o_productionAttempt").where({ attemptId }).first();
    if (!attempt) fail("PRODUCTION_ATTEMPT_NOT_FOUND", "图片生产任务不存在");
    if (attempt.status !== "RUNNING") {
      if (attempt.status === "STALE") await hooks.onStale?.(q, attempt, null, attempt.staleCode ?? "PRODUCTION_ATTEMPT_SUPERSEDED");
      return { attemptId, status: attempt.status, staleCode: attempt.staleCode ?? null };
    }
    const scope = { projectId: attempt.projectId, scriptId: attempt.scriptId, storyboardId: attempt.subjectId };
    const storyboard = await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId }).first();
    const staleCode = await currentImageDrift(q, attempt, storyboard, scope);
    if (!staleCode) return { attemptId, status: "RUNNING", staleCode: null };
    const now = Date.now();
    await q("o_productionAttempt").where({ attemptId }).update({ status: "STALE", staleCode, staleReason: "生产来源或控制状态已变化", completedAt: now, updatedAt: now });
    if (storyboard?.activeImageAttemptId === attemptId) await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
      .update({ activeImageAttemptId: null, state: storyboard.filePath ? "已完成" : "未生成", reason: staleCode });
    await hooks.onStale?.(q, attempt, null, staleCode);
    return { attemptId, status: "STALE", staleCode };
  };
  return transaction ? check(transaction) : database().transaction(check);
}

export async function finishCurrentImageAttempt(attemptId: string, output: Output, hooks: CurrentImageAttemptHooks = {}) {
  return database().transaction(async q => {
    const attempt = await q("o_productionAttempt").where({ attemptId }).first();
    if (!attempt) fail("PRODUCTION_ATTEMPT_NOT_FOUND", "图片生产任务不存在");
    const scope = { projectId: attempt.projectId, scriptId: attempt.scriptId, storyboardId: attempt.subjectId };
    const now = Date.now(), outputRef = canonicalJson(output);
    if (attempt.status !== "RUNNING" && attempt.status !== "STALE") return { attemptId, status: attempt.status };
    if (hooks.preRecordOutput) {
      const rejected = await hooks.preRecordOutput(q, attempt, output);
      if (rejected) {
        if (attempt.status === "STALE") return { attemptId, status: "STALE", staleCode: attempt.staleCode ?? rejected };
        await q("o_productionAttempt").where({ attemptId }).update({ status: "STALE", staleCode: rejected,
          staleReason: "Capability 输出来源证明失败", completedAt: now, updatedAt: now });
        const owned = await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId,
          activeImageAttemptId: attemptId }).first();
        if (owned) await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId,
          activeImageAttemptId: attemptId }).update({ activeImageAttemptId: null, state: owned.filePath ? "已完成" : "未生成", reason: rejected });
        await hooks.onStale?.(q, attempt, null, rejected);
        return { attemptId, status: "STALE", staleCode: rejected };
      }
    }
    if (attempt.status === "STALE") {
      await q("o_productionAttempt").where({ attemptId }).update({ outputRef, completedAt: now, updatedAt: now });
      await hooks.onStale?.(q, attempt, output, attempt.staleCode ?? "PRODUCTION_ATTEMPT_SUPERSEDED");
      return { attemptId, status: "STALE", staleCode: attempt.staleCode };
    }
    if (attempt.status !== "RUNNING") return { attemptId, status: attempt.status };
    const storyboard = await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId }).first();
    let staleCode: string | null = !storyboard ? "PRODUCTION_SUBJECT_CHANGED" : storyboard.activeImageAttemptId !== attemptId ? "PRODUCTION_ATTEMPT_SUPERSEDED" : null;
    if (!staleCode) staleCode = hooks.validateOutput ? await hooks.validateOutput(q, attempt, output, scope) :
      hooks.preRecordOutput ? null : await outputProvenanceCode(q, attempt, output, scope);
    if (!staleCode) staleCode = await currentImageDrift(q, attempt, storyboard, scope);
    if (staleCode) {
      await q("o_productionAttempt").where({ attemptId }).update({ status: "STALE", staleCode, staleReason: "生产来源或控制状态已变化，输出仅保留在任务记录中", outputRef, completedAt: now, updatedAt: now });
      if (storyboard?.activeImageAttemptId === attemptId) await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
        .update({ activeImageAttemptId: null, state: storyboard.filePath ? "已完成" : "未生成", reason: staleCode });
      await hooks.onStale?.(q, attempt, output, staleCode);
      return { attemptId, status: "STALE", staleCode };
    }
    await q("o_productionAttempt").where({ attemptId }).update({ status: "SUCCEEDED", outputRef, completedAt: now, updatedAt: now });
    await hooks.onSuccess?.(q, attempt, output);
    await q("o_storyboard").where({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId })
      .update({ filePath: output.filePath, currentImageAttemptId: attemptId, activeImageAttemptId: null, state: "已完成", reason: "",
        ...(attempt.producerType === "MANUAL_ATTACH" ? { flowId: output.flowId, shouldGenerateImage: 1 } : {}) });
    return { attemptId, status: "SUCCEEDED" };
  });
}

export async function finishStoryboardImageAttempt(attemptId: string, output: Output) { return finishCurrentImageAttempt(attemptId, output); }

export async function failCurrentImageAttempt(attemptId: string, error: unknown, hooks: CurrentImageAttemptHooks = {}) {
  return database().transaction(async q => {
    const attempt = await q("o_productionAttempt").where({ attemptId }).first();
    if (!attempt) return;
    if (attempt.status === "STALE") { await hooks.onStale?.(q, attempt, null, attempt.staleCode ?? "PRODUCTION_ATTEMPT_SUPERSEDED"); return; }
    if (attempt.status !== "RUNNING") return;
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "STORYBOARD_PRODUCTION_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    await q("o_productionAttempt").where({ attemptId }).update({ status: "FAILED", errorCode: code, error: message, completedAt: Date.now(), updatedAt: Date.now() });
    await hooks.onFail?.(q, attempt, code, message);
    const where = { id: attempt.subjectId, projectId: attempt.projectId, scriptId: attempt.scriptId, activeImageAttemptId: attemptId };
    const row = await q("o_storyboard").where(where).first();
    if (row) await q("o_storyboard").where(where).update({ activeImageAttemptId: null, state: row.filePath ? "已完成" : "生成失败", reason: row.filePath ? "" : `${code}: ${message}` });
  });
}

export async function failStoryboardImageAttempt(attemptId: string, error: unknown) { return failCurrentImageAttempt(attemptId, error); }

export async function runStoryboardImageAttempt(attempt: Awaited<ReturnType<typeof beginStoryboardImageAttempt>>) {
  try {
    let output: Output;
    if (attempt.producerType === "REAL_ASSET_DIRECT") {
      output = { filePath: attempt.producerInput.filePath, mediaType: "image/*", assetId: attempt.producerInput.assetId,
        imageId: attempt.producerInput.imageId, assetKey: attempt.producerInput.assetKey };
    } else if (attempt.producerType === "CAPABILITY") {
      const execution = await executePinnedImageCapability(attempt.attemptId);
      if (execution.status === "RUNNING") {
        const current = await database()("o_productionAttempt").where({ attemptId: attempt.attemptId }).first();
        return { attemptId: attempt.attemptId, status: current?.status ?? "RUNNING" };
      }
      output = execution.output;
      return finishCurrentImageAttempt(attempt.attemptId, output, { preRecordOutput: preRecordCapabilityOutput });
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
    const row = await database()("o_productionAttempt").where({ attemptId: attempt.attemptId }).first();
    return { attemptId: attempt.attemptId, status: row?.status ?? "FAILED" };
  }
}

export async function preRecordCapabilityOutput(q: Knex.Transaction, attempt: any, output: Output) {
  let reservedId: string | null = null;
  try { reservedId = parseJson(attempt.producerInput)?.reservedExecutionId ?? null; } catch { /* invalid pin */ }
  const execution = reservedId ? await q("o_capabilityExecution").where({ executionId: reservedId }).first() : null;
  return proveCapabilityImageOutput(attempt, execution, output as CapabilityImageOutput) ? null : provenanceMismatchCode;
}

export async function loadCurrentCapabilityEvidence(q: Knex.Transaction, currentAttempts: any[]) {
  const ids = [...new Set(currentAttempts.filter(row => row?.producerType === "CAPABILITY").map(row => {
    try { return parseJson(row.producerInput)?.reservedExecutionId as string | undefined; } catch { return undefined; }
  }).filter((id): id is string => !!id))].sort();
  const rows = ids.length ? await q("o_capabilityExecution").whereIn("executionId", ids) : [];
  const byId = new Map<string, any>(rows.map(row => [row.executionId, row]));
  const projection = currentAttempts.filter(row => row?.producerType === "CAPABILITY").map(row => {
    let id: string | null = null;
    try { id = parseJson(row.producerInput)?.reservedExecutionId ?? null; } catch { /* corrupt pin is explicit missing evidence */ }
    const execution = id ? byId.get(id) : null;
    let inputs: any = null, image: any = null;
    try { inputs = execution ? JSON.parse(execution.inputs) : null; } catch { /* corrupt evidence */ }
    try { image = execution ? JSON.parse(execution.outputs)?.image ?? null : null; } catch { /* corrupt evidence */ }
    return { attemptId: row.attemptId, reservedExecutionId: id, present: !!execution,
      executionId: execution?.executionId ?? null, status: execution?.status ?? null,
      capabilityId: execution?.capabilityId ?? null, definitionHash: execution?.definitionHash ?? null,
      endpointId: execution?.endpointId ?? null, inputs, promptId: execution?.promptId ?? null,
      image: image ? { filePath: image.filePath ?? null, mimeType: image.mimeType ?? null,
        outputHash: image.outputHash ?? null, byteLength: image.byteLength ?? null } : null };
  }).sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  return { byId, projection };
}

export function assessCurrentImageOutput(row: any, current: any, sourceHash: string | null,
  evidence: Map<string, any>): { freshness: "NONE" | "LEGACY" | "CURRENT" | "STALE"; staleCode: string | null } {
  if (!row.filePath) return { freshness: "NONE", staleCode: null };
  if (!row.currentImageAttemptId) return { freshness: "LEGACY", staleCode: null };
  let output: any = null;
  try { output = parseJson(current?.outputRef); } catch { /* invalid persisted provenance */ }
  if (!current || current.status !== "SUCCEEDED" || output?.filePath !== row.filePath)
    return { freshness: "STALE", staleCode: "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH" };
  if (current.producerType === "CAPABILITY") {
    let reservedId: string | null = null;
    try { reservedId = parseJson(current.producerInput)?.reservedExecutionId ?? null; } catch { /* invalid pin */ }
    if (!reservedId || !proveCapabilityImageOutput(current, evidence.get(reservedId), output))
      return { freshness: "STALE", staleCode: provenanceMismatchCode };
  }
  if (!sourceHash || current.sourceHash !== sourceHash) return { freshness: "STALE", staleCode: "PRODUCTION_SOURCE_CHANGED" };
  return { freshness: "CURRENT", staleCode: null };
}

export async function readImageProvenance(projectId: number, scriptId: number, storyboards: any[]) {
  const ids = storyboards.map(row => row.id).filter(Boolean);
  if (!ids.length) return new Map<number, any>();
  return database().transaction(async q => {
    const attempts = await q("o_productionAttempt").where({ projectId, scriptId, subjectType }).whereIn("subjectId", ids).orderBy("startedAt", "desc").orderByRaw("rowid DESC");
    let sourceContext: StoryboardImageSourceContext | null = null;
    try { sourceContext = await loadStoryboardImageSourceContext(q, projectId, scriptId, ids); }
    catch (error) { if (!(error instanceof RecipeError)) throw error; }
    const byId = new Map(attempts.map(a => [a.attemptId, a]));
    const currentRows = storyboards.map(row => row.currentImageAttemptId ? byId.get(row.currentImageAttemptId) : null).filter(Boolean);
    const capabilityEvidence = await loadCurrentCapabilityEvidence(q, currentRows);
    const latest = new Map<number, any>();
    for (const attempt of attempts) if (!latest.has(attempt.subjectId)) latest.set(attempt.subjectId, attempt);
    const result = new Map<number, any>();
    for (const requestedRow of storyboards) {
      const row = sourceContext?.rows.get(requestedRow.id) ?? requestedRow;
      const current = row.currentImageAttemptId ? byId.get(row.currentImageAttemptId) : null;
      let assessment = assessCurrentImageOutput(row, current, null, capabilityEvidence.byId);
      if (assessment.freshness === "STALE") {
        try {
          if (!sourceContext) throw new RecipeError("RECIPE_CONTEXT_MISMATCH", "精确 Recipe 上下文不可证明", 409);
          const source = buildStoryboardImageSource(sourceContext, { projectId, scriptId, storyboardId: row.id });
          assessment = assessCurrentImageOutput(row, current, source.sourceHash, capabilityEvidence.byId);
        } catch { if (assessment.staleCode !== provenanceMismatchCode) assessment = { freshness: "STALE", staleCode: "PRODUCTION_SOURCE_CHANGED" }; }
      }
      const { freshness, staleCode } = assessment;
      result.set(row.id, { freshness, currentAttemptId: row.currentImageAttemptId ?? null, activeAttemptId: row.activeImageAttemptId ?? null,
        producerType: current?.producerType ?? null, producerRef: current?.producerRef ?? null, sourceHash: current?.sourceHash ?? null,
        staleCode, staleReason: staleCode ? "当前镜头来源与保留图片不一致" : null, latestAttemptStatus: latest.get(row.id)?.status ?? null });
    }
    return result;
  });
}

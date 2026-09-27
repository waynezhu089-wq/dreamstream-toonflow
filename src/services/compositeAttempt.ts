import u from "@/utils";
import type { Knex } from "knex";
import sharp from "sharp";
import { createHash } from "crypto";
import { z } from "zod";
import { advertisementProductionContext } from "./advertisementProductionContext";
import { assertAssetPlanBinding } from "./advertisementAssetPlan";
import { productionSpec } from "./storyboardProduction";
import { generateCompositeBackground, validateBackground, type BackgroundInput } from "./compositeBackground";
import { CompositeError, perspectiveComposite, validateQuad, type ScreenQuad } from "./compositeGeometry";
import { beginCurrentImageAttempt, captureStoryboardImageSource, failCurrentImageAttempt,
  finishCurrentImageAttempt, recheckCurrentImageAttempt, type CurrentImageAttemptHooks } from "./productionAttempt";
import { readProductionOperationAdmission } from "./orchestrator/productionOperationGuard";

const db = () => u.db as Knex;
const scopeSchema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), storyboardId: z.number().int().positive() });
export type CompositeScope = z.infer<typeof scopeSchema>;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shotWhere = (scope: CompositeScope) => ({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId });
const operationKey = "storyboard.image.composite";
const finalPathFor = (attempt: any) => `/${attempt.projectId}/composite/${attempt.scriptId}/${attempt.storyboardId}/${attempt.id}/final.png`;
const backgroundPathFor = (attempt: any) => `/${attempt.projectId}/composite/${attempt.scriptId}/${attempt.storyboardId}/${attempt.id}/background.png`;
async function controlled(scope: CompositeScope) {
  const admission = await readProductionOperationAdmission(operationKey, scope);
  return admission.enforced;
}
function hooks(id: number): CurrentImageAttemptHooks {
  return {
    validateOutput: async (trx, generic, output) => {
      const detail = await trx("o_compositeAttempt").where({ id }).first();
      const input = JSON.parse(generic.producerInput);
      return generic.operationKey === operationKey && generic.producerType === "REAL_AI_COMPOSITE" &&
        generic.producerRef === `compositeAttempt:${id}` && input?.compositeAttemptId === id &&
        detail?.productionAttemptId === generic.attemptId && detail.status === "COMPOSITING" && detail.screenQuad &&
        output.filePath === finalPathFor(detail) && output.outputHash && output.byteLength ? null : "PRODUCTION_OUTPUT_PROVENANCE_MISMATCH";
    },
    onSuccess: async (trx, _generic, output) => {
      await trx("o_compositeAttempt").where({ id }).update({ finalPath: output.filePath, status: "COMPLETED", errorCode: null, error: null, updatedAt: Date.now() });
    },
    onStale: async (trx, _generic, output, staleCode) => {
      await trx("o_compositeAttempt").where({ id }).update({ ...(output ? { finalPath: output.filePath } : {}),
        status: "STALE", errorCode: staleCode, error: "生产来源、控制状态或任务所有权已变化", updatedAt: Date.now() });
    },
    onFail: async (trx, _generic, code, message) => {
      await trx("o_compositeAttempt").where({ id }).update({ status: "FAILED", errorCode: code, error: message, updatedAt: Date.now() });
    },
  };
}
async function settleControlledFailure(attemptId: string, detailedId: number, error: unknown) {
  const current = await recheckCurrentImageAttempt(attemptId, hooks(detailedId));
  if (current.status === "RUNNING") await failCurrentImageAttempt(attemptId, error, hooks(detailedId));
}
async function controlledSource(scope: CompositeScope, primaryAssetId: number) {
  const source = await db().transaction(trx => captureStoryboardImageSource(trx, scope));
  if (source.producerType !== "REAL_AI_COMPOSITE" || source.producerInput.assetId !== primaryAssetId)
    throw new CompositeError("PRIMARY_ASSET_INVALID", "当前分镜真实主素材不匹配");
  return source;
}
async function shot(scope: CompositeScope) {
  scopeSchema.parse(scope);
  const row = await db()("o_storyboard").where(shotWhere(scope)).first();
  if (!row) throw new CompositeError("PRIMARY_ASSET_INVALID", "分镜不属于当前项目和制作单元");
  const spec = productionSpec(row);
  if (spec.productionMode !== "REAL_AI_COMPOSITE") throw new CompositeError("BACKGROUND_CAPABILITY_UNSUPPORTED", "当前分镜不是背景加真实素材合成模式");
  if (spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) throw new CompositeError("BACKGROUND_CAPABILITY_UNSUPPORTED", "单镜合成原型只消费指定真实主素材，不支持附加参考图或素材组");
  return { row, spec };
}
async function source(scope: CompositeScope, primaryAssetId: number) {
  const { row, spec } = await shot(scope);
  if (!Number.isSafeInteger(primaryAssetId) || spec.primaryAssetId !== primaryAssetId) throw new CompositeError("PRIMARY_ASSET_INVALID", "主素材与分镜指定素材不一致");
  const asset = await db()("o_assets").where({ id: primaryAssetId }).first();
  if (!asset) throw new CompositeError("PRIMARY_ASSET_NOT_FOUND", "主素材不存在");
  try {
    const context = await advertisementProductionContext(scope.projectId, scope.scriptId);
    if (!context?.assets.some(a => a.assetId === primaryAssetId)) throw Error("素材未绑定到当前已确认素材清单");
    await db().transaction(trx => assertAssetPlanBinding(trx, scope, { assetId: primaryAssetId, sourcePolicy: "REAL_REQUIRED" }));
    const image = await db()("o_image").where({ id: asset.imageId, assetsId: asset.id }).first();
    const bytes = await u.oss.getFile(image.filePath);
    if (!bytes) throw Error("真实素材文件不存在");
    await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
    return { row, image, bytes, hash: digest(bytes) };
  } catch (e: any) { throw new CompositeError("PRIMARY_ASSET_INVALID", `真实素材校验失败：${e.message}`); }
}
async function current(trx: Knex | Knex.Transaction, attempt: any) {
  const latest = await trx("o_compositeAttempt").where({ projectId: attempt.projectId, scriptId: attempt.scriptId, storyboardId: attempt.storyboardId }).orderBy("id", "desc").first();
  const row = await trx("o_storyboard").where(shotWhere(attempt)).first();
  return latest?.id === attempt.id && row?.productionSpec === attempt.productionSpec;
}
async function failed(attempt: any, error: any, fallback: string) {
  const code = error instanceof CompositeError ? error.code : fallback;
  const message = error?.message || "合成失败";
  await db().transaction(async trx => {
    await trx("o_compositeAttempt").where({ id: attempt.id }).update({ status: "FAILED", errorCode: code, error: message, updatedAt: Date.now() });
    if (await current(trx, attempt)) await trx("o_storyboard").where(shotWhere(attempt)).update({ state: "生成失败", filePath: "", reason: `${code}: ${message}` });
  });
}
export async function readCompositeAttempt(input: CompositeScope & { attemptId?: number }) {
  const scope = scopeSchema.parse(input);
  if (!await db()("o_storyboard").where(shotWhere(scope)).first()) throw new CompositeError("PRIMARY_ASSET_INVALID", "分镜不属于当前项目和制作单元");
  const query = db()("o_compositeAttempt").where(scope);
  if (input.attemptId !== undefined) query.where({ id: z.number().int().positive().parse(input.attemptId) });
  let row = await query.orderBy("id", "desc").first();
  if (!row) return null;
  if (row.productionAttemptId && ["BACKGROUND_GENERATING", "BACKGROUND_RUNNING", "AWAITING_QUAD", "COMPOSITING"].includes(row.status)) {
    await recheckCurrentImageAttempt(row.productionAttemptId, hooks(row.id));
    row = await db()("o_compositeAttempt").where({ id: row.id }).first();
  }
  const generic = row.productionAttemptId ? await db()("o_productionAttempt").where({ attemptId: row.productionAttemptId,
    projectId: scope.projectId, scriptId: scope.scriptId, subjectId: scope.storyboardId }).first() : null;
  const storyboard = generic ? await db()("o_storyboard").where(shotWhere(scope)).first() : null;
  const status = generic && ["BACKGROUND_GENERATING", "BACKGROUND_RUNNING", "AWAITING_QUAD", "COMPOSITING"].includes(row.status) &&
    (generic.status !== "RUNNING" || storyboard?.activeImageAttemptId !== generic.attemptId)
    ? generic.status === "FAILED" ? "FAILED" : "STALE" : row.status;
  return { ...row, status, productionAttemptStatus: generic?.status ?? null, seed: Number(row.seed), screenQuad: row.screenQuad ? JSON.parse(row.screenQuad) : null,
    backgroundUrl: row.backgroundPath ? await u.oss.getFileUrl(row.backgroundPath) : null,
    finalUrl: row.finalPath ? await u.oss.getFileUrl(row.finalPath) : null };
}
// Starting a new attempt only touches this shot. Every attempt owns its quad.
export async function createCompositeAttempt(input: CompositeScope & BackgroundInput & { primaryAssetId: number }) {
  const scope = scopeSchema.parse(input); validateBackground(input);
  await shot(scope);
  if (await controlled(scope)) {
    const initial = await controlledSource(scope, input.primaryAssetId);
    const pinned = productionSpec(initial.row).capabilityId;
    if (pinned && pinned !== input.backgroundCapabilityId) throw new CompositeError("BACKGROUND_CAPABILITY_UNSUPPORTED", "请求的背景 Capability 与分镜锁定版本不一致");
    // This byte hash is the real uploaded source image; the generic Attempt's
    // sourceHash is instead the canonical, mode-aware Shot Source hash.
    let bytes: Buffer;
    try {
      bytes = await u.oss.getFile(initial.producerInput.filePath);
      if (!bytes) throw Error("missing source");
      await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
      await sharp(bytes, { limitInputPixels: 40000000 }).resize(1, 1).toBuffer();
    } catch { throw new CompositeError("PRIMARY_ASSET_INVALID", "真实主素材文件不存在或无法读取"); }
    const sourceByteHash = digest(bytes);
    const id = await db().transaction(async trx => {
      const [id] = await trx("o_compositeAttempt").insert({ ...scope, primaryAssetId: input.primaryAssetId,
        sourceImageId: initial.producerInput.imageId, sourcePath: initial.producerInput.filePath, sourceHash: sourceByteHash,
        productionSpec: initial.row.productionSpec, backgroundCapabilityId: input.backgroundCapabilityId, prompt: input.prompt,
        width: input.width, height: input.height, seed: String(input.seed), status: "BACKGROUND_GENERATING", createdAt: Date.now(), updatedAt: Date.now() });
      await beginCurrentImageAttempt(scope, operationKey, (_q, source) => {
        if (source.producerType !== "REAL_AI_COMPOSITE" || source.sourceHash !== initial.sourceHash ||
          source.producerInput.assetId !== input.primaryAssetId || source.producerInput.imageId !== initial.producerInput.imageId ||
          source.producerInput.filePath !== initial.producerInput.filePath)
          throw new CompositeError("PRIMARY_ASSET_INVALID", "读取真实素材期间分镜或绑定已变化");
        return { producerType: "REAL_AI_COMPOSITE", producerRef: `compositeAttempt:${id}`,
          producerInput: { compositeAttemptId: id, backgroundCapabilityId: input.backgroundCapabilityId, prompt: input.prompt,
            width: input.width, height: input.height, seed: input.seed, assetId: input.primaryAssetId,
            imageId: initial.producerInput.imageId, sourcePath: initial.producerInput.filePath, sourceByteHash } };
      }, trx, { onAttemptCreated: async (q, attemptId) => {
        await q("o_compositeAttempt").where({ id }).update({ productionAttemptId: attemptId });
      } });
      await trx("o_storyboard").where(shotWhere(scope)).update({ reason: "背景生成中，旧图片保留" });
      return id;
    });
    return (await readCompositeAttempt({ ...scope, attemptId: id }))!;
  }
  const real = await source(scope, input.primaryAssetId);
  const pinnedCapability = productionSpec(real.row).capabilityId;
  if (pinnedCapability && pinnedCapability !== input.backgroundCapabilityId) throw new CompositeError("BACKGROUND_CAPABILITY_UNSUPPORTED", "请求的背景 Capability 与分镜锁定版本不一致");
  const id = await db().transaction(async trx => {
    const [id] = await trx("o_compositeAttempt").insert({ ...scope, primaryAssetId: input.primaryAssetId,
      sourceImageId: real.image.id, sourcePath: real.image.filePath, sourceHash: real.hash, productionSpec: real.row.productionSpec,
      backgroundCapabilityId: input.backgroundCapabilityId, prompt: input.prompt, width: input.width, height: input.height, seed: String(input.seed),
      status: "BACKGROUND_GENERATING", createdAt: Date.now(), updatedAt: Date.now() });
    await trx("o_storyboard").where(shotWhere(scope)).update({ state: "生成中", filePath: "", reason: "背景生成中，尚未完成真实素材合成" });
    return id;
  });
  return (await readCompositeAttempt({ ...scope, attemptId: id }))!;
}
export async function runCompositeBackground(scope: CompositeScope & { attemptId: number }) {
  const attempt = await readCompositeAttempt(scope);
  if (attempt?.productionAttemptId) {
    if (attempt.status !== "BACKGROUND_GENERATING") return attempt;
    const ready = await db().transaction(async trx => {
      const check = await recheckCurrentImageAttempt(attempt.productionAttemptId!, hooks(attempt.id), trx);
      if (check.status !== "RUNNING") return false;
      return !!await trx("o_compositeAttempt").where({ id: attempt.id, productionAttemptId: attempt.productionAttemptId,
        status: "BACKGROUND_GENERATING" }).update({ status: "BACKGROUND_RUNNING", updatedAt: Date.now() });
    });
    if (!ready) return readCompositeAttempt(scope);
    try {
      const result = await generateCompositeBackground(attempt);
      const metadata = await sharp(result.bytes).metadata();
      if (metadata.width !== attempt.width || metadata.height !== attempt.height) throw Error("背景尺寸与请求不一致");
      const backgroundPath = backgroundPathFor(attempt), backgroundHash = digest(result.bytes);
      await u.oss.writeFile(backgroundPath, result.bytes);
      await db().transaction(async trx => {
        await trx("o_compositeAttempt").where({ id: attempt.id, productionAttemptId: attempt.productionAttemptId })
          .update({ backgroundPath, backgroundHash, backgroundPromptId: result.promptId, updatedAt: Date.now() });
        const check = await recheckCurrentImageAttempt(attempt.productionAttemptId!, hooks(attempt.id), trx);
        if (check.status !== "RUNNING") return;
        if (!await trx("o_compositeAttempt").where({ id: attempt.id, status: "BACKGROUND_RUNNING" })
          .update({ status: "AWAITING_QUAD", updatedAt: Date.now() })) return;
        await trx("o_storyboard").where({ ...shotWhere(attempt), activeImageAttemptId: attempt.productionAttemptId })
          .update({ reason: "背景已生成，请人工确认屏幕四角；旧图片保留" });
      });
    } catch (error) { await settleControlledFailure(attempt.productionAttemptId, attempt.id, error); }
    return readCompositeAttempt(scope);
  }
  if (!attempt || attempt.status !== "BACKGROUND_GENERATING") throw new CompositeError("BACKGROUND_GENERATION_FAILED", "背景尝试不存在或已执行");
  // CAS prevents duplicate submissions of the same attempt.
  if (!await db()("o_compositeAttempt").where({ id: attempt.id, status: "BACKGROUND_GENERATING" }).update({ status: "BACKGROUND_RUNNING" })) return;
  try {
    const result = await generateCompositeBackground(attempt);
    const metadata = await sharp(result.bytes).metadata();
    if (metadata.width !== attempt.width || metadata.height !== attempt.height) throw Error("背景尺寸与请求不一致");
    const backgroundPath = `/${attempt.projectId}/composite/${attempt.scriptId}/${attempt.storyboardId}/${attempt.id}/background.png`;
    await u.oss.writeFile(backgroundPath, result.bytes);
    await db().transaction(async trx => {
      if (!await current(trx, attempt)) throw new CompositeError("COMPOSITE_FAILED", "该尝试已被重试或分镜修改替代");
      await trx("o_compositeAttempt").where({ id: attempt.id }).update({ backgroundPath, backgroundHash: digest(result.bytes), backgroundPromptId: result.promptId, status: "AWAITING_QUAD", updatedAt: Date.now() });
      await trx("o_storyboard").where(shotWhere(attempt)).update({ state: "未生成", filePath: "", reason: "背景已生成，请确认屏幕四角后合成真实素材" });
    });
  } catch (e) { await failed(attempt, e, "BACKGROUND_GENERATION_FAILED"); }
  return readCompositeAttempt(scope);
}
export async function finishCompositeAttempt(input: CompositeScope & { attemptId: number; screenQuad: ScreenQuad; confirmed: boolean }) {
  const attempt = await readCompositeAttempt(input);
  if (attempt?.productionAttemptId) {
    if (attempt.status !== "AWAITING_QUAD") throw new CompositeError("COMPOSITE_FAILED", "当前合成尝试已结束或不再拥有该镜头");
    validateQuad(input.screenQuad, attempt.width, attempt.height);
    if (input.confirmed !== true) throw new CompositeError("SCREEN_QUAD_REQUIRED", "请人工确认四角后执行合成");
    const ready = await db().transaction(async trx => {
      const check = await recheckCurrentImageAttempt(attempt.productionAttemptId!, hooks(attempt.id), trx);
      if (check.status !== "RUNNING") return false;
      return !!await trx("o_compositeAttempt").where({ id: attempt.id, productionAttemptId: attempt.productionAttemptId,
        status: "AWAITING_QUAD" }).update({ status: "COMPOSITING", screenQuad: JSON.stringify(input.screenQuad), updatedAt: Date.now() });
    });
    if (!ready) return readCompositeAttempt(input);
    try {
      // External byte work never runs inside the freshness transaction.
      const bytes = await u.oss.getFile(attempt.sourcePath);
      if (!bytes || digest(bytes) !== attempt.sourceHash) throw new CompositeError("PRIMARY_ASSET_INVALID", "真实素材字节已变化，请重新开始合成");
      await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
      await sharp(bytes, { limitInputPixels: 40000000 }).resize(1, 1).toBuffer();
      const background = await u.oss.getFile(attempt.backgroundPath);
      if (!background || digest(background) !== attempt.backgroundHash) throw new CompositeError("COMPOSITE_FAILED", "背景文件已变化，请重新开始合成");
      const final = await perspectiveComposite(background, bytes, input.screenQuad);
      const finalPath = finalPathFor(attempt);
      await u.oss.writeFile(finalPath, final);
      await finishCurrentImageAttempt(attempt.productionAttemptId, { filePath: finalPath, mediaType: "image/png",
        outputHash: digest(final), byteLength: final.length }, hooks(attempt.id));
    } catch (error) { await settleControlledFailure(attempt.productionAttemptId, attempt.id, error); }
    return readCompositeAttempt(input);
  }
  if (!attempt || attempt.status !== "AWAITING_QUAD") throw new CompositeError("COMPOSITE_FAILED", "请先生成背景；已结束的尝试请新建重试");
  validateQuad(input.screenQuad, attempt.width, attempt.height);
  if (input.confirmed !== true) throw new CompositeError("SCREEN_QUAD_REQUIRED", "请人工确认四角后执行合成");
  await db().transaction(async trx => {
    if (!await current(trx, attempt)) throw new CompositeError("COMPOSITE_FAILED", "该尝试已被新的背景或分镜修改替代");
    if (!await trx("o_compositeAttempt").where({ id: attempt.id, status: "AWAITING_QUAD" }).update({ status: "COMPOSITING", screenQuad: JSON.stringify(input.screenQuad), updatedAt: Date.now() })) throw new CompositeError("COMPOSITE_FAILED", "该尝试正在合成");
  });
  try {
    const real = await source(attempt, attempt.primaryAssetId);
    if (real.hash !== attempt.sourceHash || real.image.id !== attempt.sourceImageId || real.image.filePath !== attempt.sourcePath) throw new CompositeError("PRIMARY_ASSET_INVALID", "真实素材已变更，请重新生成尝试并确认");
    const bg = await u.oss.getFile(attempt.backgroundPath);
    if (!bg || digest(bg) !== attempt.backgroundHash) throw new CompositeError("COMPOSITE_FAILED", "背景文件已改变，请重试");
    const final = await perspectiveComposite(bg, real.bytes, input.screenQuad);
    const finalPath = `/${attempt.projectId}/composite/${attempt.scriptId}/${attempt.storyboardId}/${attempt.id}/final.png`;
    await u.oss.writeFile(finalPath, final);
    // Recheck binding/provenance within the final write transaction too.
    await source(attempt, attempt.primaryAssetId);
    await db().transaction(async trx => {
      if (!await current(trx, attempt)) throw new CompositeError("COMPOSITE_FAILED", "该尝试已被替代，不覆盖新结果");
      const binding = await trx("o_advertisementAssetPlan").where({ projectId: attempt.projectId, scriptId: attempt.scriptId, assetId: attempt.primaryAssetId }).first();
      const asset = await trx("o_assets").where({ id: attempt.primaryAssetId, projectId: attempt.projectId }).first();
      const image = asset ? await trx("o_image").where({ id: asset.imageId, assetsId: asset.id }).first() : null;
      if (!binding || image?.id !== attempt.sourceImageId || image?.filePath !== attempt.sourcePath) throw new CompositeError("PRIMARY_ASSET_INVALID", "合成期间绑定或当前图片发生变化，请重试");
      await assertAssetPlanBinding(trx, attempt, { assetId: attempt.primaryAssetId, sourcePolicy: "REAL_REQUIRED" });
      await trx("o_compositeAttempt").where({ id: attempt.id, status: "COMPOSITING" }).update({ finalPath, status: "COMPLETED", errorCode: null, error: null, updatedAt: Date.now() });
      await trx("o_storyboard").where(shotWhere(attempt)).update({ filePath: finalPath, state: "已完成", reason: "" });
    });
  } catch (e) { await failed(attempt, e, "COMPOSITE_FAILED"); }
  return readCompositeAttempt(input);
}

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

const db = () => u.db as Knex;
const scopeSchema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), storyboardId: z.number().int().positive() });
export type CompositeScope = z.infer<typeof scopeSchema>;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shotWhere = (scope: CompositeScope) => ({ id: scope.storyboardId, projectId: scope.projectId, scriptId: scope.scriptId });
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
  const scope = scopeSchema.parse(input); await shot(scope);
  const query = db()("o_compositeAttempt").where(scope);
  if (input.attemptId !== undefined) query.where({ id: z.number().int().positive().parse(input.attemptId) });
  const row = await query.orderBy("id", "desc").first();
  if (!row) return null;
  return { ...row, seed: Number(row.seed), screenQuad: row.screenQuad ? JSON.parse(row.screenQuad) : null,
    backgroundUrl: row.backgroundPath ? await u.oss.getFileUrl(row.backgroundPath) : null,
    finalUrl: row.finalPath ? await u.oss.getFileUrl(row.finalPath) : null };
}
// Starting a new attempt only touches this shot. Every attempt owns its quad.
export async function createCompositeAttempt(input: CompositeScope & BackgroundInput & { primaryAssetId: number }) {
  const scope = scopeSchema.parse(input); validateBackground(input);
  const real = await source(scope, input.primaryAssetId);
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

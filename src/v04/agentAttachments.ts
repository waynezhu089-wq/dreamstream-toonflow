import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import sharp from "sharp";
import { z } from "zod";
import { db } from "@/utils/db";
import u from "@/utils";
import getPath from "@/utils/getPath";
import { recordAssetUpload } from "@/services/assetUploadSource";
import { ASSET_PLAN_TABLE } from "@/lib/advertisementAssetPlanSchema";
import { PilotError } from "./service";

const id = z.number().int().positive();
const context = z.object({ projectId: id, scriptId: id.nullable(), currentStage: z.string().max(80), currentRoute: z.string().max(200), selectedObject: z.object({ type: z.enum(["ASSET", "SHOT", "PROJECT"]), key: z.string().max(128) }).nullable() }).strict();
const attachmentId = z.string().uuid();
const targetType = z.enum(["PROJECT_REFERENCE", "ASSET_BIBLE", "BIND_SELECTED_ASSET", "SHOT_REFERENCE", "PRODUCTION_ASSET"]);
const promotion = z.object({ context, attachmentId, targetType, targetKey: z.string().max(128).nullable(), previewHash: z.string().length(64).optional() }).strict();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const imageType = { jpeg: { mime: "image/jpeg", ext: "jpg" }, png: { mime: "image/png", ext: "png" }, webp: { mime: "image/webp", ext: "webp" } } as const;
function privateImagePath(row: { projectId: number; id: string; mimeType: string }) {
  const ext = row.mimeType === "image/jpeg" ? "jpg" : row.mimeType === "image/webp" ? "webp" : "png";
  return path.join(getPath("v04-conversation"), String(row.projectId), `${row.id}.${ext}`);
}

export async function uploadAgentImage(input: unknown) {
  const { context: ctx, name, dataUrl } = z.object({ context, name: z.string().trim().min(1).max(200), dataUrl: z.string().max(11_000_000) }).strict().parse(input);
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new PilotError("PILOT_IMAGE_INVALID", "仅支持 PNG、JPEG、WebP 图片", 400);
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new PilotError("PILOT_IMAGE_TOO_LARGE", "图片不能超过 8 MB", 413);
  let format: keyof typeof imageType;
  try {
    const meta = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata();
    if (!meta.width || !meta.height || !meta.format || !(meta.format in imageType) || (meta.pages ?? 1) !== 1 || meta.width * meta.height > 16_000_000) throw Error("invalid image");
    format = meta.format as keyof typeof imageType;
    if (`data:${imageType[format].mime};` !== dataUrl.slice(0, dataUrl.indexOf("base64,"))) throw Error("mime mismatch");
  } catch { throw new PilotError("PILOT_IMAGE_INVALID", "图片内容无效或格式与声明不符", 400); }
  const project = await db("o_project").where({ id: ctx.projectId }).first();
  if (!project) throw new PilotError("PILOT_SCOPE_INVALID", "项目不存在", 404);
  if (ctx.scriptId !== null && !await db("o_script").where({ id: ctx.scriptId, projectId: ctx.projectId }).first()) throw new PilotError("PILOT_SCOPE_INVALID", "制作单元不属于当前项目", 404);
  const fileId = randomUUID();
  const filePath = `/v04-conversation/${ctx.projectId}/${fileId}.${imageType[format].ext}`;
  const privatePath = privateImagePath({ projectId: ctx.projectId, id: fileId, mimeType: imageType[format].mime });
  await fs.mkdir(path.dirname(privatePath), { recursive: true });
  await fs.writeFile(privatePath, bytes, { flag: "wx" });
  try {
    await db("o_v04AgentAttachment").insert({ id: fileId, projectId: ctx.projectId, scriptId: ctx.scriptId, messageId: null, contextJson: JSON.stringify(ctx), filePath, originalName: name, mimeType: imageType[format].mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), purpose: "CONVERSATIONAL_REFERENCE", createdAt: Date.now() });
  } catch (error) { await fs.unlink(privatePath).catch(() => {}); throw error; }
  return { id: fileId, name, mimeType: imageType[format].mime, bytes: bytes.length, purpose: "CONVERSATIONAL_REFERENCE" };
}

export async function readAgentAttachment(projectId: number, idValue: string) {
  const row = await db("o_v04AgentAttachment").where({ id: attachmentId.parse(idValue), projectId }).first();
  if (!row) throw new PilotError("PILOT_ATTACHMENT_NOT_FOUND", "图片不属于当前项目", 404);
  return row;
}

export async function getAgentAttachmentBytes(projectId: number, idValue: string) {
  const row = await readAgentAttachment(projectId, idValue);
  return { row, bytes: await fs.readFile(privateImagePath(row)) };
}

export async function attachmentsForMessage(projectId: number, ids: string[]) {
  if (!ids.length) return [];
  if (ids.length > 4 || new Set(ids).size !== ids.length) throw new PilotError("PILOT_ATTACHMENT_INVALID", "一次最多发送四张不同图片", 400);
  ids.forEach(value => attachmentId.parse(value));
  const rows = await db("o_v04AgentAttachment").where({ projectId }).whereIn("id", ids);
  if (rows.length !== ids.length || rows.some(row => row.messageId !== null || row.purpose !== "CONVERSATIONAL_REFERENCE")) throw new PilotError("PILOT_ATTACHMENT_INVALID", "图片不存在、已发送或不是对话参考", 409);
  return ids.map(value => rows.find(row => row.id === value)!);
}

export async function imageParts(rows: any[]) {
  return Promise.all(rows.map(async row => ({ type: "image" as const, image: `data:${row.mimeType};base64,${(await fs.readFile(privateImagePath(row))).toString("base64")}` })));
}

async function planAttachmentPromotion(trx: Knex.Transaction, data: z.infer<typeof promotion>) {
  const ctx = data.context;
    const attachment = await trx("o_v04AgentAttachment").where({ id: data.attachmentId, projectId: ctx.projectId }).first();
    if (!attachment?.messageId) throw new PilotError("PILOT_ATTACHMENT_INVALID", "仅已发送的对话图片可提出引用", 409);
    let target: any = null;
    let binding: any = null;
    let plan: any = null;
    if (["BIND_SELECTED_ASSET", "PRODUCTION_ASSET"].includes(data.targetType)) {
      if (!data.targetKey) throw new PilotError("PILOT_TARGET_REQUIRED", "请先选择素材身份");
      target = await trx("o_v04Asset").where({ projectId: ctx.projectId, canonicalKey: data.targetKey, status: "ACTIVE" }).first();
      if (!target) throw new PilotError("PILOT_TARGET_INVALID", "素材身份不存在或已退休", 404);
      if (data.targetType === "PRODUCTION_ASSET") {
        if (ctx.scriptId === null) throw new PilotError("PILOT_UNIT_REQUIRED", "请选择制作单元");
        binding = await trx("o_v04AssetBinding").where({ projectId: ctx.projectId, scriptId: ctx.scriptId, canonicalKey: data.targetKey }).first();
        plan = await trx(ASSET_PLAN_TABLE).where({ projectId: ctx.projectId, scriptId: ctx.scriptId, assetKey: data.targetKey }).first();
        if (!binding || !plan || (plan.assetId != null && plan.assetId !== binding.assetId)) throw new PilotError("PILOT_TARGET_INVALID", "当前素材清单绑定与身份不一致，请在资产准备中处理", 409);
      }
    }
    if (data.targetType === "SHOT_REFERENCE") {
      if (ctx.scriptId === null || !data.targetKey || !/^\d+$/.test(data.targetKey)) throw new PilotError("PILOT_TARGET_REQUIRED", "请先选择当前镜头");
      target = await trx("o_storyboard").where({ id: Number(data.targetKey), projectId: ctx.projectId, scriptId: ctx.scriptId }).whereNull("retiredAt").first();
      if (!target) throw new PilotError("PILOT_TARGET_INVALID", "镜头不属于当前制作单元", 404);
    }
    if (data.targetType === "ASSET_BIBLE" && data.targetKey) {
      target = await trx("o_v04Asset").where({ projectId: ctx.projectId, canonicalKey: data.targetKey, status: "ACTIVE" }).first();
      if (!target) throw new PilotError("PILOT_TARGET_INVALID", "素材身份不存在", 404);
    }
    const current = { attachment: { id: attachment.id, sha256: attachment.sha256, messageId: attachment.messageId, purpose: attachment.purpose }, target: target && { id: target.id ?? target.canonicalKey, revision: target.revision ?? null, retiredAt: target.retiredAt ?? null }, binding, plan };
    return { current, previewHash: sha({ projectId: ctx.projectId, scriptId: ctx.scriptId, attachmentId: data.attachmentId, targetType: data.targetType, targetKey: data.targetKey, current }), notice: data.targetType === "PRODUCTION_ASSET" ? "确认后将原始上传图片复制为当前制作单元的正式素材，记录服务器上传来源，并由 Asset Plan 校验；这可能替换该资产的当前图片。" : "确认后只登记参考关系，不改变正式素材、素材清单、分镜或生产产物。" };
}
export async function previewAttachmentPromotion(input: unknown) {
  const data = promotion.parse(input);
  const result = await db.transaction(trx => planAttachmentPromotion(trx, data));
  return { ...result, action: { targetType: data.targetType, targetKey: data.targetKey }, attachmentId: data.attachmentId };
}

export async function applyAttachmentPromotion(input: unknown) {
  const data = promotion.extend({ previewHash: z.string().length(64) }).parse(input);
  const attachment = await readAgentAttachment(data.context.projectId, data.attachmentId);
  let productionPath: string | null = null;
  if (data.targetType === "PRODUCTION_ASSET") {
    const ext = attachment.mimeType === "image/jpeg" ? "jpg" : attachment.mimeType === "image/webp" ? "webp" : "png";
    productionPath = `/${data.context.projectId}/v04-promoted/${randomUUID()}.${ext}`;
    await u.oss.writeFile(productionPath, await fs.readFile(privateImagePath(attachment)));
  }
  try {
    return await db.transaction(async trx => {
      // The exact plan is re-captured in this write transaction.
      const currentPlan = await planAttachmentPromotion(trx, data);
      if (currentPlan.previewHash !== data.previewHash) throw new PilotError("PILOT_PREVIEW_STALE", "图片引用预览已过期", 409);
      const prior = await trx("o_v04AgentReference").where({ projectId: data.context.projectId, attachmentId: data.attachmentId, targetType: data.targetType, targetKey: data.targetKey }).first();
      if (prior) throw new PilotError("PILOT_REFERENCE_EXISTS", "该图片用途已经确认", 409);
      let assetId: number | null = null;
      if (productionPath) {
        const scope = { projectId: data.context.projectId, scriptId: data.context.scriptId, canonicalKey: data.targetKey };
        const binding = await trx("o_v04AssetBinding").where(scope).first();
        const plan = await trx(ASSET_PLAN_TABLE).where({ projectId: scope.projectId, scriptId: scope.scriptId, assetKey: scope.canonicalKey }).first();
        const target = await trx("o_v04Asset").where({ projectId: scope.projectId, canonicalKey: scope.canonicalKey, status: "ACTIVE" }).first();
        const asset = binding && await trx("o_assets").where({ id: binding.assetId, projectId: scope.projectId, scriptId: scope.scriptId }).first();
        if (!target || !asset || !plan || (plan.assetId != null && plan.assetId !== asset.id)) throw new PilotError("PILOT_PREVIEW_STALE", "素材归属或清单已经变化", 409);
        assetId = asset.id;
        const [imageId] = await trx("o_image").insert({ assetsId: asset.id, filePath: productionPath, type: asset.type, state: "已完成" });
        await trx("o_assets").where({ id: asset.id, projectId: scope.projectId }).update({ imageId });
        await recordAssetUpload(trx, { projectId: scope.projectId, assetId: asset.id, imageId, filePath: productionPath });
        await trx(ASSET_PLAN_TABLE).where({ projectId: scope.projectId, scriptId: scope.scriptId, assetKey: scope.canonicalKey }).update({ assetId: asset.id });
      }
      const referenceId = randomUUID();
      await trx("o_v04AgentReference").insert({ id: referenceId, projectId: data.context.projectId, scriptId: data.context.scriptId, attachmentId: data.attachmentId, targetType: data.targetType, targetKey: data.targetKey, assetId, createdAt: Date.now() });
      return { referenceId, assetId, applied: true, purpose: productionPath ? "PRODUCTION_ASSET" : "CONVERSATIONAL_REFERENCE" };
    });
  } catch (error) { if (productionPath) await u.oss.deleteFile(productionPath).catch(() => {}); throw error; }
}


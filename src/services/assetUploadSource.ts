import type { Knex } from "knex";
import { UPLOAD_SOURCE_TABLE } from "@/lib/advertisementAssetPlanSchema";

// Internal only. Call in the upload transaction, after writeFile succeeded and
// the asset's new image was persisted. Never accept a client source declaration.
export async function recordAssetUpload(
  trx: Knex.Transaction,
  source: { projectId: number; assetId: number; imageId: number; filePath: string },
) {
  const asset = await trx("o_assets").where({ id: source.assetId, projectId: source.projectId, imageId: source.imageId }).first();
  const image = await trx("o_image").where({ id: source.imageId, assetsId: source.assetId, filePath: source.filePath, state: "已完成" }).first();
  if (!asset || !image || !source.filePath || image.model) throw new Error("上传来源记录与资产不一致");
  await trx(UPLOAD_SOURCE_TABLE).insert({ ...source, uploadedAt: Date.now() });
}

import type { Knex } from "knex";

export const ASSET_PLAN_TABLE = "o_advertisementAssetPlan";
export const UPLOAD_SOURCE_TABLE = "o_assetUploadSource";

// Additive initialization for both existing installations and fresh databases.
// No changes to legacy tables or Gate state; no inferred provenance backfill.
export async function initializeAssetPlanSchema(db: Knex) {
  await db.transaction(async (trx) => {
    if (!(await trx.schema.hasTable(ASSET_PLAN_TABLE))) {
      await trx.schema.createTable(ASSET_PLAN_TABLE, (table) => {
        table.integer("projectId").notNullable();
        table.integer("scriptId").notNullable();
        table.string("assetKey", 128).notNullable();
        table.string("name").notNullable();
        table.string("category").notNullable();
        table.boolean("required").notNullable();
        table.enu("sourcePolicy", ["REAL_REQUIRED", "AI_ALLOWED"]).notNullable();
        table.integer("assetId").nullable();
        table.integer("position").notNullable();
        table.primary(["projectId", "scriptId", "assetKey"]);
      });
    }
    if (!(await trx.schema.hasTable(UPLOAD_SOURCE_TABLE))) {
      await trx.schema.createTable(UPLOAD_SOURCE_TABLE, (table) => {
        table.integer("projectId").notNullable();
        table.integer("assetId").notNullable();
        table.integer("imageId").notNullable();
        table.text("filePath").notNullable();
        table.bigInteger("uploadedAt").notNullable();
        table.primary(["assetId", "imageId"]);
      });
    }
  });
}

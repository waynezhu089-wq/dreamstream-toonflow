import type { Knex } from "knex";
export async function initializeCompositeAttemptSchema(db: Knex) {
  await db.transaction(async trx => {
    if (!(await trx.schema.hasTable("o_compositeAttempt"))) await trx.schema.createTable("o_compositeAttempt", t => {
      t.increments("id");
      for (const key of ["projectId", "scriptId", "storyboardId", "primaryAssetId", "sourceImageId", "width", "height"]) t.bigInteger(key).notNullable();
      for (const key of ["sourcePath", "sourceHash", "productionSpec", "backgroundCapabilityId", "prompt", "seed", "status"]) t.text(key).notNullable();
      for (const key of ["backgroundPath", "backgroundHash", "backgroundPromptId", "screenQuad", "finalPath", "errorCode", "error"]) t.text(key).nullable();
      t.text("productionAttemptId").nullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
      t.index(["projectId", "scriptId", "storyboardId", "id"]);
    });
    if (!(await trx.schema.hasColumn("o_compositeAttempt", "productionAttemptId")))
      await trx.schema.alterTable("o_compositeAttempt", t => t.text("productionAttemptId").nullable());
    await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_composite_production_attempt ON o_compositeAttempt(productionAttemptId) WHERE productionAttemptId IS NOT NULL");
  });
}

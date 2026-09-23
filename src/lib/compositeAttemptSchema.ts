import type { Knex } from "knex";
export async function initializeCompositeAttemptSchema(db: Knex) {
  await db.transaction(async trx => {
    if (await trx.schema.hasTable("o_compositeAttempt")) return;
    await trx.schema.createTable("o_compositeAttempt", t => {
      t.increments("id");
      for (const key of ["projectId", "scriptId", "storyboardId", "primaryAssetId", "sourceImageId", "width", "height"]) t.bigInteger(key).notNullable();
      for (const key of ["sourcePath", "sourceHash", "productionSpec", "backgroundCapabilityId", "prompt", "seed", "status"]) t.text(key).notNullable();
      for (const key of ["backgroundPath", "backgroundHash", "backgroundPromptId", "screenQuad", "finalPath", "errorCode", "error"]) t.text(key).nullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
      t.index(["projectId", "scriptId", "storyboardId", "id"]);
    });
  });
}

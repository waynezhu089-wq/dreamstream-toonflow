import type { Knex } from "knex";

// Nullable JSON envelope: existing rows/legacy profiles retain their old behavior.
// Group IDs are opaque references; a future group service can resolve them without
// changing the storyboard contract or migrating every item again.
export async function initializeStoryboardProductionSchema(db: Knex) {
  await db.transaction(async trx => {
    // Legacy bootstrap creates fresh tables asynchronously. Fresh table builder
    // includes the column; this migration only upgrades tables already present.
    if (!(await trx.schema.hasTable("o_storyboard"))) return;
    if (!(await trx.schema.hasColumn("o_storyboard", "productionSpec"))) {
      await trx.schema.alterTable("o_storyboard", table => table.text("productionSpec").nullable());
    }
    if (!(await trx.schema.hasColumn("o_storyboard", "imagePrompt"))) {
      await trx.schema.alterTable("o_storyboard", table => table.text("imagePrompt").nullable());
    }
    for (const column of ["currentImageAttemptId", "activeImageAttemptId"]) {
      if (!(await trx.schema.hasColumn("o_storyboard", column))) {
        await trx.schema.alterTable("o_storyboard", table => table.text(column).nullable());
      }
    }
    if (!(await trx.schema.hasTable("o_productionAttempt"))) {
      await trx.schema.createTable("o_productionAttempt", table => {
        table.text("attemptId").primary();
        table.integer("projectId").notNullable(); table.integer("scriptId").notNullable();
        table.text("profileKey").notNullable(); table.integer("profileVersion").notNullable(); table.text("profileDefinitionHash").notNullable();
        table.text("recipeKey").nullable(); table.integer("recipeVersion").nullable(); table.text("recipeDefinitionHash").nullable();
        table.text("stageKey").notNullable(); table.text("operationKey").notNullable();
        table.text("subjectType").notNullable(); table.integer("subjectId").notNullable();
        table.text("sourceAdapterKey").notNullable(); table.text("sourceHash").notNullable(); table.text("sourceSnapshot").notNullable();
        table.text("producerType").notNullable(); table.text("producerRef").nullable(); table.text("producerInput").notNullable();
        table.text("controlContextHash").notNullable(); table.text("controlSnapshot").notNullable();
        table.text("status").notNullable(); table.text("outputRef").nullable();
        table.text("staleCode").nullable(); table.text("staleReason").nullable(); table.text("errorCode").nullable(); table.text("error").nullable();
        table.bigInteger("startedAt").notNullable(); table.bigInteger("completedAt").nullable(); table.bigInteger("updatedAt").notNullable();
        table.index(["projectId", "scriptId", "subjectType", "subjectId", "startedAt"], "idx_production_attempt_subject");
        table.index(["status", "startedAt"], "idx_production_attempt_status");
      });
    }
    await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_production_attempt_running_image ON o_productionAttempt(projectId, scriptId, subjectType, subjectId) WHERE status = 'RUNNING' AND subjectType = 'STORYBOARD_IMAGE'");
  });
}

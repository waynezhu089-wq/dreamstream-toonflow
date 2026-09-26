import type { Knex } from "knex";

// Additive V0.3 review provenance. Existing production and control-plane tables stay intact.
export async function initializeSupervisorSchema(db: Knex) {
  await db.transaction(async trx => {
    if (!await trx.schema.hasTable("o_supervisorReview")) await trx.schema.createTable("o_supervisorReview", t => {
      t.string("reviewId", 36).primary();
      t.integer("projectId").notNullable(); t.integer("scriptId").notNullable();
      t.string("profileKey", 160).notNullable(); t.integer("profileVersion").notNullable();
      t.string("recipeKey", 160).nullable(); t.integer("recipeVersion").nullable(); t.string("recipeDefinitionHash", 64).nullable();
      t.string("reviewKey", 160).notNullable(); t.string("targetAdapterKey", 160).notNullable(); t.string("targetType", 80).notNullable();
      t.string("targetHash", 64).notNullable(); t.string("controlContextHash", 64).notNullable(); t.text("targetSnapshot").notNullable();
      t.string("decision", 20).notNullable(); t.string("source", 20).notNullable(); t.text("summary").notNullable(); t.text("issues").notNullable();
      t.string("supervisorSkillId", 160).nullable(); t.integer("supervisorSkillVersion").nullable(); t.string("supervisorSkillDefinitionHash", 64).nullable();
      t.string("supervisorResolutionHash", 64).nullable(); t.text("supervisorResolutionTrace").nullable(); t.text("supervisorOverrideChain").nullable();
      t.string("modelReference", 256).nullable(); t.integer("actorUserId").nullable(); t.string("actorDisplayName", 256).nullable();
      t.bigInteger("createdAt").notNullable();
      t.index(["projectId", "scriptId", "reviewKey", "targetHash", "createdAt"], "idx_supervisor_review_target");
    });
    for (const [name, add] of [
      ["supervisorResolutionHash", (t: Knex.AlterTableBuilder) => t.string("supervisorResolutionHash", 64).nullable()],
      ["supervisorResolutionTrace", (t: Knex.AlterTableBuilder) => t.text("supervisorResolutionTrace").nullable()],
      ["supervisorOverrideChain", (t: Knex.AlterTableBuilder) => t.text("supervisorOverrideChain").nullable()],
    ] as const) if (!await trx.schema.hasColumn("o_supervisorReview", name)) await trx.schema.alterTable("o_supervisorReview", add);
    await trx.raw("CREATE TRIGGER IF NOT EXISTS supervisor_review_no_update BEFORE UPDATE ON o_supervisorReview BEGIN SELECT RAISE(ABORT, 'supervisor reviews are immutable'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS supervisor_review_no_delete BEFORE DELETE ON o_supervisorReview BEGIN SELECT RAISE(ABORT, 'supervisor reviews are immutable'); END");
  });
}

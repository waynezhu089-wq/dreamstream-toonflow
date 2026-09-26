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
  });
}

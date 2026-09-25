import type { Knex } from "knex";

export async function initializeRecipeSchema(db: Knex) {
  await db.transaction(async trx => {
    if (!await trx.schema.hasTable("o_recipe")) await trx.schema.createTable("o_recipe", t => {
      t.string("recipeKey", 160).primary(); t.string("displayName", 256).notNullable(); t.text("description").notNullable(); t.text("tags").notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    if (!await trx.schema.hasTable("o_recipeVersion")) await trx.schema.createTable("o_recipeVersion", t => {
      t.string("recipeKey", 160).notNullable(); t.integer("version").notNullable(); t.string("status", 20).notNullable();
      t.text("definition").notNullable(); t.string("definitionHash", 64).notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable(); t.bigInteger("activatedAt").nullable(); t.bigInteger("deprecatedAt").nullable();
      t.primary(["recipeKey", "version"]);
    });
    if (!await trx.schema.hasTable("o_projectRecipeBinding")) await trx.schema.createTable("o_projectRecipeBinding", t => {
      t.integer("projectId").primary(); t.string("recipeKey", 160).notNullable(); t.integer("recipeVersion").notNullable();
      t.string("recipeDefinitionHash", 64).notNullable(); t.string("source", 24).notNullable(); t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_one_active ON o_recipeVersion(recipeKey) WHERE status = 'ACTIVE'");
  });
}

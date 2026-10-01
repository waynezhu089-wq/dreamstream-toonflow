import type { Knex } from "knex";
export async function initializeModelPresetSchema(db: Knex) {
  await db.transaction(async trx => {
    if (!await trx.schema.hasTable("o_modelPreset")) await trx.schema.createTable("o_modelPreset", t => {
      t.string("id").primary(); t.string("name").notNullable(); t.text("slots").notNullable();
    });
    if (!await trx.schema.hasTable("o_modelScope")) await trx.schema.createTable("o_modelScope", t => {
      t.string("scope").primary(); t.string("presetId").nullable(); t.text("slots").notNullable();
    });
  });
}

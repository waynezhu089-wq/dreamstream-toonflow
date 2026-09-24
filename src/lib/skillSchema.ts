import type { Knex } from "knex";

// Independent V0.3 control plane. Legacy o_skillList/o_skillAttribution are untouched.
export async function initializeSkillSchema(db: Knex) {
  await db.transaction(async trx => {
    if (!(await trx.schema.hasTable("o_skillRegistry"))) await trx.schema.createTable("o_skillRegistry", t => {
      t.string("skillId", 160).primary(); t.string("displayName", 256).notNullable();
      t.string("skillType", 40).notNullable(); t.text("description").notNullable();
      t.text("tags").notNullable(); t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    if (!(await trx.schema.hasTable("o_skillVersion"))) await trx.schema.createTable("o_skillVersion", t => {
      t.string("skillId", 160).notNullable(); t.integer("version").notNullable();
      t.string("status", 20).notNullable(); t.string("templateId", 40).notNullable();
      t.text("content").notNullable(); t.string("sourceType", 40).notNullable();
      t.text("sourceData").notNullable(); t.string("definitionHash", 64).notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("activatedAt").nullable();
      t.bigInteger("updatedAt").notNullable(); t.primary(["skillId", "version"]);
      t.index(["skillId", "status"]);
    });
    if (!(await trx.schema.hasTable("o_skillBinding"))) await trx.schema.createTable("o_skillBinding", t => {
      t.string("scopeType", 20).notNullable(); t.string("scopeKey", 256).notNullable();
      t.string("skillType", 40).notNullable(); t.string("skillId", 160).nullable();
      t.integer("skillVersion").nullable(); t.text("overrideText").nullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
      t.primary(["scopeType", "scopeKey", "skillType"]); t.index(["skillId", "skillVersion"]);
    });
    if (!(await trx.schema.hasTable("o_skillCompile"))) await trx.schema.createTable("o_skillCompile", t => {
      t.string("compileId", 64).primary(); t.integer("projectId").notNullable();
      t.integer("scriptId").notNullable(); t.integer("storyboardId").notNullable();
      t.string("skillId", 160).notNullable(); t.integer("skillVersion").notNullable();
      t.string("skillDefinitionHash", 64).notNullable(); t.text("resolutionTrace").notNullable();
      t.text("overrideChain").notNullable(); t.text("inputContext").notNullable();
      t.text("outputPrompt").notNullable(); t.string("modelReference", 256).notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("appliedAt").nullable();
      t.index(["projectId", "scriptId", "storyboardId"]);
    });
  });
}

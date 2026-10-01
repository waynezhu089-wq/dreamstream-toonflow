import type { Knex } from "knex";

// Four additive tables. Legacy project, storyboard and model tables are untouched.
export async function initializeCapabilitySchema(db: Knex) {
  await db.transaction(async trx => {
    if (!(await trx.schema.hasTable("o_capability"))) await trx.schema.createTable("o_capability", t => {
      t.string("familyKey", 160).primary(); t.string("displayName", 256).notNullable();
      t.text("description").notNullable(); t.string("category", 100).notNullable();
      t.string("provider", 80).notNullable(); t.string("executorType", 40).notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    if (!(await trx.schema.hasTable("o_capabilityEndpoint"))) await trx.schema.createTable("o_capabilityEndpoint", t => {
      t.string("id", 64).primary(); t.string("name", 256).notNullable(); t.text("baseUrl").notNullable();
      t.boolean("enabled").notNullable(); t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    if (!(await trx.schema.hasTable("o_capabilityVersion"))) await trx.schema.createTable("o_capabilityVersion", t => {
      t.string("capabilityId", 180).primary(); t.string("familyKey", 160).notNullable();
      t.integer("version").notNullable(); t.string("status", 20).notNullable();
      for (const key of ["workflowJson", "inputPorts", "outputPorts", "inputMappings", "outputMappings", "runtimeConfig"]) t.text(key).notNullable();
      t.string("endpointId", 64).notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("verifiedAt").nullable(); t.bigInteger("updatedAt").notNullable();
      t.unique(["familyKey", "version"]);
      t.index(["familyKey", "status"]);
    });
    if (!(await trx.schema.hasTable("o_capabilityExecution"))) await trx.schema.createTable("o_capabilityExecution", t => {
      t.string("executionId", 64).primary(); t.string("capabilityId", 180).notNullable();
      t.string("endpointId", 64).notNullable(); t.string("promptId", 128).nullable();
      t.string("status", 24).notNullable(); t.text("inputs").notNullable(); t.text("outputs").notNullable();
      t.text("error").nullable(); t.string("definitionHash", 64).notNullable();
      t.bigInteger("startedAt").notNullable(); t.bigInteger("completedAt").nullable();
      t.index(["capabilityId", "startedAt"]);
    });
  });
}

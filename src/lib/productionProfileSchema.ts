import type { Knex } from "knex";
import { advertisementV1, definitionHash } from "@/services/orchestrator/profileDefinition";

// Additive V0.3 control-plane schema. Never alter V0.2 production tables.
export async function initializeProductionProfileSchema(db: Knex) {
  await db.transaction(async trx => {
    if (!await trx.schema.hasTable("o_productionProfile")) await trx.schema.createTable("o_productionProfile", t => {
      t.string("profileKey", 160).primary(); t.string("displayName", 256).notNullable(); t.text("description").notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    if (!await trx.schema.hasTable("o_productionProfileVersion")) await trx.schema.createTable("o_productionProfileVersion", t => {
      t.string("profileKey", 160).notNullable(); t.integer("version").notNullable(); t.string("status", 20).notNullable();
      t.text("definition").notNullable(); t.string("definitionHash", 64).notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
      t.bigInteger("activatedAt").nullable(); t.bigInteger("deprecatedAt").nullable();
      t.primary(["profileKey", "version"]); t.index(["profileKey", "status"]);
    });
    if (!await trx.schema.hasTable("o_projectProfileBinding")) await trx.schema.createTable("o_projectProfileBinding", t => {
      t.integer("projectId").primary(); t.string("profileKey", 160).notNullable(); t.integer("profileVersion").notNullable();
      t.string("source", 24).notNullable(); t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable();
    });
    if (!await trx.schema.hasTable("o_stageRun")) await trx.schema.createTable("o_stageRun", t => {
      t.integer("projectId").notNullable(); t.integer("scriptId").notNullable(); t.string("profileKey", 160).notNullable();
      t.integer("profileVersion").notNullable(); t.string("stageKey", 160).notNullable(); t.string("state", 20).notNullable();
      t.bigInteger("startedAt").nullable(); t.bigInteger("completedAt").nullable(); t.bigInteger("skippedAt").nullable();
      t.bigInteger("updatedAt").notNullable(); t.text("lastReason").nullable();
      t.primary(["projectId", "scriptId", "profileKey", "profileVersion", "stageKey"]);
    });
    if (!await trx.schema.hasTable("o_stageEvent")) await trx.schema.createTable("o_stageEvent", t => {
      t.increments("id").primary(); t.integer("projectId").notNullable(); t.integer("scriptId").notNullable();
      t.string("profileKey", 160).notNullable(); t.integer("profileVersion").notNullable(); t.string("stageKey", 160).notNullable();
      t.string("eventType", 20).notNullable(); t.string("fromState", 20).notNullable(); t.string("toState", 20).notNullable();
      t.text("reason").nullable(); t.string("actorType", 20).notNullable(); t.bigInteger("createdAt").notNullable();
      t.index(["projectId", "scriptId", "profileKey", "profileVersion", "id"]);
    });
    await trx.raw("CREATE TRIGGER IF NOT EXISTS stage_event_no_update BEFORE UPDATE ON o_stageEvent BEGIN SELECT RAISE(ABORT, 'stage events are immutable'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS stage_event_no_delete BEFORE DELETE ON o_stageEvent BEGIN SELECT RAISE(ABORT, 'stage events are immutable'); END");
    // SQLite uniqueness also protects concurrent activations from producing two ACTIVE versions.
    await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_one_active ON o_productionProfileVersion(profileKey) WHERE status = 'ACTIVE'");
    const now = Date.now();
    await trx("o_productionProfile").insert({ profileKey: "advertisement", displayName: "Advertisement", description: "广告制作工艺", createdAt: now, updatedAt: now }).onConflict("profileKey").ignore();
    const active = await trx("o_productionProfileVersion").where({ profileKey: "advertisement", status: "ACTIVE" }).first();
    await trx("o_productionProfileVersion").insert({ profileKey: "advertisement", version: 1, status: active ? "DEPRECATED" : "ACTIVE", definition: JSON.stringify(advertisementV1), definitionHash: definitionHash(advertisementV1), createdAt: now, updatedAt: now, activatedAt: active ? null : now, deprecatedAt: active ? now : null }).onConflict(["profileKey", "version"]).ignore();
  });
}

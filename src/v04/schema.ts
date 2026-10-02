import type { Knex } from "knex";
import { advertisement001eDefinition } from "@/services/orchestrator/videoProductionProfile";
import { definitionHash } from "@/services/orchestrator/profileDefinition";

// Experimental authoring data. Existing production tables remain the authority
// for media, Gate, Stage, Attempt and accepted video state.
export async function initializeV04Schema(db: Knex) {
  if (!await db.schema.hasTable("o_v04Creative")) await db.schema.createTable("o_v04Creative", t => {
    t.integer("projectId").notNullable();
    t.integer("scriptId").notNullable();
    t.text("brief").notNullable();
    t.text("treatment").notNullable().defaultTo("");
    t.text("script").notNullable().defaultTo("");
    t.integer("targetDuration").notNullable();
    t.text("aspectRatio").notNullable();
    t.integer("version").notNullable().defaultTo(1);
    t.integer("updatedAt").notNullable();
    t.primary(["projectId", "scriptId"]);
  });
  if (!await db.schema.hasTable("o_v04Decision")) await db.schema.createTable("o_v04Decision", t => {
    t.text("id").primary();
    t.integer("projectId").notNullable().index();
    t.integer("scriptId").nullable();
    t.text("category").notNullable();
    t.text("subjectType").nullable();
    t.text("subjectKey").nullable();
    t.text("content").notNullable();
    t.text("status").notNullable();
    t.text("sourceMessageIds").notNullable().defaultTo("[]");
    t.text("supersedesDecisionId").nullable();
    t.integer("createdAt").notNullable();
    t.integer("acceptedAt").nullable();
  });
  if (!await db.schema.hasTable("o_v04Asset")) await db.schema.createTable("o_v04Asset", t => {
    t.integer("projectId").notNullable();
    t.text("canonicalKey").notNullable();
    t.text("category").notNullable();
    t.text("name").notNullable();
    t.text("description").notNullable().defaultTo("");
    t.text("identityAnchors").notNullable().defaultTo("[]");
    t.text("mustPreserve").notNullable().defaultTo("[]");
    t.text("forbiddenChanges").notNullable().defaultTo("[]");
    t.text("ownerKey").nullable();
    t.text("variantOf").nullable();
    t.text("sourcePolicy").notNullable();
    t.text("prompt").notNullable().defaultTo("");
    t.text("status").notNullable().defaultTo("ACTIVE");
    t.integer("revision").notNullable().defaultTo(1);
    t.integer("createdAt").notNullable();
    t.integer("updatedAt").notNullable();
    t.primary(["projectId", "canonicalKey"]);
  });
  if (!await db.schema.hasTable("o_v04AssetSequence")) await db.schema.createTable("o_v04AssetSequence", t => {
    t.integer("projectId").notNullable();
    t.text("prefix").notNullable();
    t.integer("nextNumber").notNullable();
    t.primary(["projectId", "prefix"]);
  });
  if (!await db.schema.hasTable("o_v04AssetBinding")) await db.schema.createTable("o_v04AssetBinding", t => {
    t.integer("projectId").notNullable();
    t.integer("scriptId").notNullable();
    t.text("canonicalKey").notNullable();
    t.integer("assetId").notNullable();
    t.primary(["projectId", "scriptId", "canonicalKey"]);
    t.unique(["projectId", "scriptId", "assetId"]);
  });
  if (!await db.schema.hasTable("o_v04AgentAttachment")) await db.schema.createTable("o_v04AgentAttachment", t => {
    t.text("id").primary();
    t.integer("projectId").notNullable().index();
    t.integer("scriptId").nullable();
    t.text("messageId").nullable().index();
    t.text("contextJson").notNullable();
    t.text("filePath").notNullable();
    t.text("originalName").notNullable();
    t.text("mimeType").notNullable();
    t.integer("bytes").notNullable();
    t.text("sha256").notNullable();
    t.text("purpose").notNullable().defaultTo("CONVERSATIONAL_REFERENCE");
    t.integer("createdAt").notNullable();
  });
  if (!await db.schema.hasTable("o_v04AgentReference")) await db.schema.createTable("o_v04AgentReference", t => {
    t.text("id").primary();
    t.integer("projectId").notNullable().index();
    t.integer("scriptId").nullable();
    t.text("attachmentId").notNullable().index();
    t.text("targetType").notNullable();
    t.text("targetKey").nullable();
    t.integer("assetId").nullable();
    t.integer("createdAt").notNullable();
  });
}

export async function initializeV04Profile(db: Knex) {
  const expectedHash = definitionHash(advertisement001eDefinition);
  await db.transaction(async trx => {
    const existing = await trx("o_productionProfileVersion").where({ profileKey: "advertisement", version: 2 }).first();
    if (existing && existing.definitionHash !== expectedHash) throw new Error("V0.4 Profile v2 conflicts with an existing exact definition");
    if (existing) return;
    const now = Date.now();
    await trx("o_productionProfileVersion").where({ profileKey: "advertisement", status: "ACTIVE" }).update({ status: "DEPRECATED", deprecatedAt: now, updatedAt: now });
    await trx("o_productionProfileVersion").insert({ profileKey: "advertisement", version: 2, status: "ACTIVE", definition: JSON.stringify(advertisement001eDefinition), definitionHash: expectedHash, createdAt: now, updatedAt: now, activatedAt: now, deprecatedAt: null });
  });
}

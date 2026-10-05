import type { Knex } from "knex";
import { advertisement001eDefinition } from "@/services/orchestrator/videoProductionProfile";
import { definitionHash } from "@/services/orchestrator/profileDefinition";
import { reviewPlanFor } from "./assetWorkflow";

// Experimental authoring data. Existing production tables remain the authority
// for media, Gate, Stage, Attempt and accepted video state.
export async function initializeV04Schema(db: Knex) {
  if (!await db.schema.hasTable("o_v04StudioImageExecutorConfig")) await db.schema.createTable("o_v04StudioImageExecutorConfig", t => {
    t.integer("projectId").primary();
    t.text("provider").notNullable().defaultTo("COMFY_LOCAL");
    t.text("baseUrl").notNullable();
    t.boolean("enabled").notNullable().defaultTo(false);
    t.text("checkpoint").notNullable();
    t.text("executorProfile").notNullable().defaultTo("LOCAL_DRAFT_V1");
    t.integer("updatedAt").notNullable();
  });
  if (!await db.schema.hasTable("o_v04StudioAssetDraftJob")) await db.schema.createTable("o_v04StudioAssetDraftJob", t => {
    t.text("id").primary();
    t.integer("projectId").notNullable(); t.integer("scriptId").notNullable(); t.text("canonicalKey").notNullable();
    t.integer("sourceAssetRevision").notNullable(); t.text("draftHash").notNullable();
    t.text("generationIntent").notNullable(); t.text("executorType").notNullable();
    t.text("executorProfile").notNullable(); t.text("workflowVersion").notNullable();
    t.text("status").notNullable(); t.text("comfyPromptId").nullable();
    t.text("inputSnapshotJson").notNullable(); t.text("outputsJson").notNullable().defaultTo("[]");
    t.text("errorCode").nullable(); t.text("errorMessage").nullable();
    t.integer("attemptCount").notNullable().defaultTo(1);
    t.integer("createdAt").notNullable(); t.integer("startedAt").nullable();
    t.integer("completedAt").nullable(); t.integer("updatedAt").notNullable();
    t.index(["projectId", "scriptId", "canonicalKey", "createdAt"], "v04_draft_job_scope_idx");
    t.index(["status", "createdAt"], "v04_draft_job_queue_idx");
  });
  if (!await db.schema.hasColumn("o_v04StudioAssetDraftJob", "executionPurpose"))
    await db.schema.alterTable("o_v04StudioAssetDraftJob", t => { t.text("executionPurpose").nullable(); });
  if (!await db.schema.hasTable("o_v04StudioDraftArtifact")) await db.schema.createTable("o_v04StudioDraftArtifact", t => {
    t.text("artifactId").primary(); t.text("jobId").notNullable().index();
    t.integer("projectId").notNullable().index(); t.text("mimeType").notNullable();
    t.text("extension").notNullable(); t.text("role").notNullable();
    t.integer("width").notNullable(); t.integer("height").notNullable(); t.integer("createdAt").notNullable();
  });
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
    t.text("assetKind").notNullable().defaultTo("OTHER");
    t.text("importance").notNullable().defaultTo("SUPPORTING");
    t.text("relatedKeys").notNullable().defaultTo("[]");
    t.text("sharedVisualSystemKey").nullable();
    t.text("status").notNullable().defaultTo("ACTIVE");
    t.integer("revision").notNullable().defaultTo(1);
    t.integer("createdAt").notNullable();
    t.integer("updatedAt").notNullable();
    t.primary(["projectId", "canonicalKey"]);
  });
  // Existing experimental pilot databases are upgraded without touching production tables.
  for (const [column, add] of [
    ["assetKind", (t: Knex.AlterTableBuilder) => t.text("assetKind").notNullable().defaultTo("OTHER")],
    ["importance", (t: Knex.AlterTableBuilder) => t.text("importance").notNullable().defaultTo("SUPPORTING")],
    ["relatedKeys", (t: Knex.AlterTableBuilder) => t.text("relatedKeys").notNullable().defaultTo("[]")],
    ["sharedVisualSystemKey", (t: Knex.AlterTableBuilder) => t.text("sharedVisualSystemKey").nullable()],
  ] as const) if (!await db.schema.hasColumn("o_v04Asset", column)) await db.schema.alterTable("o_v04Asset", add);
  if (!await db.schema.hasTable("o_v04AssetReviewPlan")) await db.schema.createTable("o_v04AssetReviewPlan", t => {
    t.integer("projectId").notNullable(); t.integer("scriptId").notNullable(); t.text("canonicalKey").notNullable();
    t.text("previewKind").notNullable(); t.text("previewStatus").notNullable(); t.text("turnaroundStatus").notNullable();
    t.text("previewFilePath").nullable(); t.text("turnaroundFilePaths").notNullable().defaultTo("[]");
    t.text("previewSpec").notNullable().defaultTo("{}"); t.text("turnaroundSpec").notNullable().defaultTo("{}");
    t.integer("updatedAt").notNullable(); t.primary(["projectId", "scriptId", "canonicalKey"]);
  });
  if (!await db.schema.hasColumn("o_v04AssetReviewPlan", "previewSpec")) await db.schema.alterTable("o_v04AssetReviewPlan", t => t.text("previewSpec").notNullable().defaultTo("{}"));
  if (!await db.schema.hasColumn("o_v04AssetReviewPlan", "turnaroundSpec")) await db.schema.alterTable("o_v04AssetReviewPlan", t => t.text("turnaroundSpec").notNullable().defaultTo("{}"));
  if (!await db.schema.hasTable("o_v04AssetCoverage")) await db.schema.createTable("o_v04AssetCoverage", t => {
    t.integer("projectId").notNullable(); t.integer("scriptId").notNullable(); t.integer("creativeVersion").notNullable();
    t.integer("position").notNullable(); t.text("label").notNullable(); t.text("coverageType").notNullable();
    t.text("classification").notNullable(); t.text("canonicalKeys").notNullable().defaultTo("[]");
    t.text("note").notNullable().defaultTo(""); t.primary(["projectId", "scriptId", "position"]);
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
  if (!await db.schema.hasTable("o_v04VisionAnalysis")) await db.schema.createTable("o_v04VisionAnalysis", t => {
    t.text("attachmentId").notNullable();
    t.text("modelFingerprint").notNullable();
    t.integer("analysisVersion").notNullable();
    t.text("observationJson").notNullable();
    t.integer("createdAt").notNullable();
    t.primary(["attachmentId", "modelFingerprint", "analysisVersion"]);
  });
  if (!await db.schema.hasTable("o_v04AssetVisualSpec")) await db.schema.createTable("o_v04AssetVisualSpec", t => {
    t.integer("projectId").notNullable(); t.text("canonicalKey").notNullable();
    t.integer("revision").notNullable(); t.text("status").notNullable();
    t.integer("sourceAssetRevision").notNullable(); t.text("specJson").notNullable();
    t.integer("createdAt").notNullable(); t.integer("updatedAt").notNullable();
    t.primary(["projectId", "canonicalKey", "revision"]);
    t.index(["projectId", "canonicalKey", "status"]);
  });
  if (!await db.schema.hasTable("o_v04AssetPromptBuild")) await db.schema.createTable("o_v04AssetPromptBuild", t => {
    t.integer("projectId").notNullable(); t.text("canonicalKey").notNullable();
    t.integer("visualSpecRevision").notNullable(); t.text("compilerVersion").notNullable();
    t.text("generationIntent").notNullable(); t.text("targetProfile").notNullable();
    t.text("promptIrJson").notNullable(); t.text("renderedPromptJson").notNullable();
    t.text("status").notNullable(); t.integer("createdAt").notNullable(); t.integer("updatedAt").notNullable();
    t.primary(["projectId", "canonicalKey", "visualSpecRevision", "compilerVersion", "generationIntent", "targetProfile"]);
    t.index(["projectId", "canonicalKey", "status"]);
  });
  if (!await db.schema.hasTable("o_v04AssetLibraryBinding")) await db.schema.createTable("o_v04AssetLibraryBinding", t => {
    t.integer("projectId").notNullable(); t.text("canonicalKey").notNullable();
    t.text("libraryAssetId").nullable(); t.integer("libraryVersion").nullable();
    t.text("visualProfileId").nullable(); t.integer("visualProfileVersion").nullable();
    t.text("reuseMode").nullable(); t.integer("createdAt").notNullable(); t.integer("updatedAt").notNullable();
    t.primary(["projectId", "canonicalKey"]);
  });
  // Previously confirmed experimental identities get an honest review plan on upgrade.
  // Existing media and production bindings are never changed by this backfill.
  const missingPlans = await db("o_v04AssetBinding as binding")
    .join("o_v04Asset as asset", function () { this.on("asset.projectId", "=", "binding.projectId").andOn("asset.canonicalKey", "=", "binding.canonicalKey"); })
    .leftJoin("o_v04AssetReviewPlan as plan", function () { this.on("plan.projectId", "=", "binding.projectId").andOn("plan.scriptId", "=", "binding.scriptId").andOn("plan.canonicalKey", "=", "binding.canonicalKey"); })
    .where("asset.status", "ACTIVE").whereNull("plan.canonicalKey")
    .select("binding.projectId", "binding.scriptId", "binding.canonicalKey", "asset.category", "asset.assetKind", "asset.importance", "asset.sourcePolicy");
  if (missingPlans.length) await db.transaction(async trx => {
    for (const row of missingPlans) await trx("o_v04AssetReviewPlan").insert({ projectId: row.projectId, scriptId: row.scriptId, canonicalKey: row.canonicalKey, ...reviewPlanFor(row), previewFilePath: null, turnaroundFilePaths: "[]", updatedAt: Date.now() }).onConflict(["projectId", "scriptId", "canonicalKey"]).ignore();
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

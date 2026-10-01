import type { Knex } from "knex";

// Explicit startup migration. Read-only Preview and normal reads never create schema.
export async function initializeRevisionSchema(db: Knex) {
  await db.transaction(async trx => {
    const add = async (table: string, column: string, define: (t: Knex.AlterTableBuilder) => void) => {
      if (await trx.schema.hasTable(table) && !await trx.schema.hasColumn(table, column)) {
        await trx.schema.alterTable(table, define);
      }
    };
    await add("o_script", "revisionEpoch", t => t.integer("revisionEpoch").notNullable().defaultTo(0));
    await add("o_storyboard", "retiredAt", t => t.bigInteger("retiredAt").nullable());
    await add("o_storyboard", "retiredByRevisionId", t => t.text("retiredByRevisionId").nullable());
    await add("o_stageEvent", "revisionId", t => t.text("revisionId").nullable());
    await add("o_stageEvent", "actorUserId", t => t.integer("actorUserId").nullable());
    await add("o_stageEvent", "actorDisplayName", t => t.text("actorDisplayName").nullable());
    await add("o_productionAttempt", "invalidatedByRevisionId", t => t.text("invalidatedByRevisionId").nullable());
    await add("o_supervisorReview", "revisionEpoch", t => t.integer("revisionEpoch").nullable());
    await add("o_videoTrack", "storyboardManaged", t => t.integer("storyboardManaged").nullable());
    await add("o_videoTrack", "promptRevisionEpoch", t => t.integer("promptRevisionEpoch").nullable());
    await add("o_video", "revisionWorkGuardId", t => t.text("revisionWorkGuardId").nullable());
    if (!await trx.schema.hasTable("o_productionRevision")) await trx.schema.createTable("o_productionRevision", t => {
      t.text("revisionId").primary(); t.integer("projectId").notNullable(); t.integer("scriptId").notNullable();
      t.text("revisionKey").notNullable(); t.text("requestHash").notNullable(); t.text("previewHash").notNullable();
      t.integer("epochBefore").notNullable(); t.integer("epochAfter").notNullable();
      t.text("humanReason").notNullable(); t.integer("actorUserId").notNullable(); t.text("actorDisplayName").notNullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("appliedAt").notNullable();
      t.text("changeJson").notNullable(); t.text("impactJson").notNullable(); t.text("resultJson").notNullable();
      t.unique(["projectId", "scriptId", "epochAfter"]); t.index(["projectId", "scriptId", "appliedAt"]);
    });
    await trx.raw("CREATE TRIGGER IF NOT EXISTS production_revision_no_update BEFORE UPDATE ON o_productionRevision BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS production_revision_no_delete BEFORE DELETE ON o_productionRevision BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS production_revision_epoch_insert BEFORE INSERT ON o_productionRevision WHEN NEW.epochBefore < 0 OR NEW.epochAfter != NEW.epochBefore + 1 BEGIN SELECT RAISE(ABORT, 'invalid revision epoch'); END");
    if (!await trx.schema.hasTable("o_revisionWorkGuard")) await trx.schema.createTable("o_revisionWorkGuard", t => {
      t.text("guardId").primary(); t.integer("projectId").notNullable(); t.integer("scriptId").notNullable();
      t.text("kind").notNullable(); t.integer("trackId").notNullable(); t.integer("admittedEpoch").notNullable();
      t.text("ownerRunId").notNullable(); t.text("state").notNullable(); t.text("outcome").nullable();
      t.bigInteger("createdAt").notNullable(); t.bigInteger("settledAt").nullable(); t.text("resolutionJson").nullable();
      t.index(["projectId", "scriptId", "state"], "idx_revision_guard_scope_state");
    });
    await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_guard_prompt_active ON o_revisionWorkGuard(projectId,scriptId,trackId) WHERE kind='VIDEO_PROMPT' AND state IN ('ACTIVE','UNCERTAIN')");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS revision_guard_valid_insert BEFORE INSERT ON o_revisionWorkGuard WHEN NEW.kind NOT IN ('VIDEO_GENERATE','VIDEO_PROMPT') OR NEW.state NOT IN ('ACTIVE','UNCERTAIN','SETTLED','FENCED') OR NEW.admittedEpoch < 0 BEGIN SELECT RAISE(ABORT, 'invalid revision work guard'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS revision_guard_valid_update BEFORE UPDATE ON o_revisionWorkGuard WHEN NEW.kind NOT IN ('VIDEO_GENERATE','VIDEO_PROMPT') OR NEW.state NOT IN ('ACTIVE','UNCERTAIN','SETTLED','FENCED') OR NEW.admittedEpoch < 0 BEGIN SELECT RAISE(ABORT, 'invalid revision work guard'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS revision_guard_no_delete BEFORE DELETE ON o_revisionWorkGuard BEGIN SELECT RAISE(ABORT, 'revision work guards are immutable history'); END");
    if (await trx.schema.hasTable("o_video")) await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_video_revision_guard ON o_video(revisionWorkGuardId) WHERE revisionWorkGuardId IS NOT NULL");
    if (await trx.schema.hasTable("o_videoTrack")) {
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_track_managed_insert BEFORE INSERT ON o_videoTrack WHEN NEW.storyboardManaged NOT NULL AND NEW.storyboardManaged != 1 BEGIN SELECT RAISE(ABORT, 'invalid storyboardManaged'); END");
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_track_managed_update BEFORE UPDATE OF storyboardManaged ON o_videoTrack WHEN NEW.storyboardManaged NOT NULL AND NEW.storyboardManaged != 1 BEGIN SELECT RAISE(ABORT, 'invalid storyboardManaged'); END");
    }
  });
}

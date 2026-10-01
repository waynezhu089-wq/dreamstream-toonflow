import type { Knex } from "knex";

export async function initializeVideoProductionSchema(db: Knex) {
  await db.transaction(async trx => {
    const add = async (column: string, define: (t: Knex.AlterTableBuilder) => void) => {
      if (await trx.schema.hasTable("o_video") && !await trx.schema.hasColumn("o_video", column)) await trx.schema.alterTable("o_video", define);
    };
    await add("sourceAdapter", t => t.text("sourceAdapter").nullable());
    await add("sourceSnapshot", t => t.text("sourceSnapshot").nullable());
    await add("sourceHash", t => t.text("sourceHash").nullable());
    await add("outputMime", t => t.text("outputMime").nullable());
    await add("outputSha256", t => t.text("outputSha256").nullable());
    await add("outputByteLength", t => t.integer("outputByteLength").nullable());
    await add("retiredAt", t => t.bigInteger("retiredAt").nullable());
    await add("retiredByUserId", t => t.integer("retiredByUserId").nullable());
    await add("retiredReason", t => t.text("retiredReason").nullable());

    if (!await trx.schema.hasTable("o_videoAcceptance")) await trx.schema.createTable("o_videoAcceptance", t => {
      t.text("acceptanceId").primary();
      t.integer("projectId").notNullable(); t.integer("scriptId").notNullable(); t.integer("trackId").notNullable();
      t.integer("videoId").notNullable(); t.text("candidateSourceHash").notNullable(); t.text("candidateOutputSha256").notNullable();
      t.integer("actorUserId").notNullable(); t.text("actorDisplayName").nullable(); t.bigInteger("acceptedAt").notNullable(); t.text("reason").nullable();
      t.index(["projectId", "scriptId", "trackId", "acceptedAt"], "idx_video_acceptance_track");
      t.index(["videoId", "acceptedAt"], "idx_video_acceptance_video");
    });
    if (await trx.schema.hasTable("o_video")) {
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_001e_no_delete BEFORE DELETE ON o_video WHEN OLD.sourceAdapter='video.track-source.v1' BEGIN SELECT RAISE(ABORT, '001E video evidence cannot be deleted'); END");
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_001e_adapter_immutable BEFORE UPDATE OF sourceAdapter ON o_video WHEN OLD.sourceAdapter='video.track-source.v1' AND NEW.sourceAdapter IS NOT OLD.sourceAdapter BEGIN SELECT RAISE(ABORT, '001E video adapter is immutable'); END");
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_001e_path_immutable BEFORE UPDATE OF filePath ON o_video WHEN OLD.sourceAdapter='video.track-source.v1' AND NEW.filePath IS NOT OLD.filePath BEGIN SELECT RAISE(ABORT, '001E video path is immutable'); END");
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_001e_source_sealed_immutable BEFORE UPDATE ON o_video WHEN OLD.sourceHash IS NOT NULL AND (NEW.sourceAdapter IS NOT OLD.sourceAdapter OR NEW.sourceSnapshot IS NOT OLD.sourceSnapshot OR NEW.sourceHash IS NOT OLD.sourceHash) BEGIN SELECT RAISE(ABORT, '001E sealed video source is immutable'); END");
      await trx.raw("CREATE TRIGGER IF NOT EXISTS video_001e_output_proof_immutable BEFORE UPDATE ON o_video WHEN OLD.outputSha256 IS NOT NULL AND (NEW.filePath IS NOT OLD.filePath OR NEW.outputMime IS NOT OLD.outputMime OR NEW.outputSha256 IS NOT OLD.outputSha256 OR NEW.outputByteLength IS NOT OLD.outputByteLength) BEGIN SELECT RAISE(ABORT, '001E video output proof is immutable'); END");
      await trx.raw("CREATE INDEX IF NOT EXISTS idx_video_001e_scope ON o_video(projectId,scriptId,videoTrackId,sourceAdapter)");
    }
    await trx.raw("CREATE TRIGGER IF NOT EXISTS video_acceptance_no_update BEFORE UPDATE ON o_videoAcceptance BEGIN SELECT RAISE(ABORT, 'video acceptances are immutable'); END");
    await trx.raw("CREATE TRIGGER IF NOT EXISTS video_acceptance_no_delete BEFORE DELETE ON o_videoAcceptance BEGIN SELECT RAISE(ABORT, 'video acceptances are immutable'); END");
  });
}

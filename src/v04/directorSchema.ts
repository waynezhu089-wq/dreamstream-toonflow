import type { Knex } from "knex";
import { reconcileDirectorLineages } from "./directorLineage";
// Invoked only by the experimental startup gate, never by a read endpoint.
export async function initializeDirectorSchema(db: Knex) {
  for (const table of [
    "o_v04DirectorProposal",
    "o_v04DirectorVersion",
    "o_v04DirectorProjection",
  ]) {
    if (await db.schema.hasTable(table)) continue;
    await db.schema.createTable(table, (t) => {
      t.text("id").primary();
      t.bigInteger("projectId").notNullable();
      t.integer("scriptId").notNullable();
      t.integer("sourceCreativeVersion").notNullable();
      t.text("sourceHash").notNullable();
      t.text("candidateHash").notNullable();
      t.integer("schemaVersion").notNullable();
      t.text("compilerVersion").notNullable();
      t.text("projectBibleJson").notNullable();
      t.text("unitProjectionJson").notNullable();
      t.text("evidenceJson").notNullable();
      t.text("status").notNullable();
      t.bigInteger("createdAt").notNullable();
      t.bigInteger("updatedAt").notNullable();
      if (table === "o_v04DirectorProposal") {
        t.text("baseProposalId").nullable();
        t.integer("baseDirectorVersion").nullable();
        t.text("previewHash").nullable();
        t.integer("actorUserId").notNullable();
        t.text("diffJson").notNullable();
      } else {
        t.integer("directorVersion").notNullable();
        t.integer("unitProjectionVersion").notNullable();
        t.text("proposalId").notNullable();
        t.text("previewHash").notNullable();
        t.integer("actorUserId").notNullable();
        t.bigInteger("confirmedAt").notNullable();
        t.unique(["proposalId"]);
        if (table === "o_v04DirectorVersion")
          t.unique(["projectId", "directorVersion"]);
        else t.unique(["projectId", "scriptId", "unitProjectionVersion"]);
      }
      t.index(["projectId", "scriptId", "createdAt"]);
    });
  }
  for (const table of ["o_v04DirectorVersion", "o_v04DirectorProjection"]) {
    await db.raw(
      `CREATE TRIGGER IF NOT EXISTS ${table}_status_validation BEFORE UPDATE ON ${table} WHEN NEW.status NOT IN ('CURRENT','SUPERSEDED','STALE') OR (OLD.status IN ('SUPERSEDED','STALE') AND NEW.status='CURRENT') BEGIN SELECT RAISE(ABORT,'DIRECTOR_STATUS_INVALID'); END`,
    );
    const columns = Object.keys(await db(table).columnInfo()).filter(
      (c) => c !== "status",
    );
    await db.raw(
      `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} WHEN ${columns.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")} BEGIN SELECT RAISE(ABORT,'DIRECTOR_VERSION_IMMUTABLE'); END`,
    );
    await db.raw(
      `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'DIRECTOR_HISTORY_IMMUTABLE'); END`,
    );
  }
  const repaired = await reconcileDirectorLineages(db);
  if (repaired.length) console.info("[V04 Director][LineageReconciliation]", JSON.stringify(repaired));
}

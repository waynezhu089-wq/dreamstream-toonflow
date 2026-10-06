import type { Knex } from "knex";
import { PilotError } from "./service";
type Scope = { projectId: number; scriptId: number };
const unit = (scope: Scope) => ({ projectId: scope.projectId, scriptId: scope.scriptId });

// Metadata only, scoped to a single unit. Fail closed instead of silently
// truncating ancestry or following a foreign-project link.
async function graph(trx: Knex.Transaction, scope: Scope) {
  const rows = await trx("o_v04DirectorProposal").where(unit(scope))
    .select("id", "baseProposalId", "status").limit(10001);
  if (rows.length > 10000) throw new PilotError("DIRECTOR_LINEAGE_LIMIT", "导演提案历史过大，无法安全解析", 422);
  return new Map(rows.map(r => [r.id, r]));
}
function ancestors(rows: Map<string, any>, root: string) {
  const seen = new Set([root]), ids: string[] = [];
  let next = rows.get(root)?.baseProposalId;
  while (next) {
    if (seen.has(next) || !rows.has(next))
      throw new PilotError("DIRECTOR_LINEAGE_INVALID", "导演提案继承关系无效", 422);
    seen.add(next); ids.push(next); next = rows.get(next).baseProposalId;
  }
  return ids;
}
export async function confirmedDirectorAncestors(trx: Knex.Transaction, scope: Scope) {
  const rows = await graph(trx, scope), ids = new Set<string>();
  const versions = await trx("o_v04DirectorVersion").where(unit(scope)).select("proposalId").limit(10001);
  if (versions.length > 10000) throw new PilotError("DIRECTOR_LINEAGE_LIMIT", "导演版本历史过大", 422);
  for (const version of versions) {
    if (!rows.has(version.proposalId)) throw new PilotError("DIRECTOR_LINEAGE_INVALID", "已确认导演提案缺失", 422);
    for (const id of ancestors(rows, version.proposalId)) ids.add(id);
  }
  return ids;
}
export async function assertActiveDirectorProposal(trx: Knex.Transaction, scope: Scope, proposal: any) {
  if (!["DRAFT", "PREVIEWED"].includes(proposal.status) ||
      (await confirmedDirectorAncestors(trx, scope)).has(proposal.id))
    throw new PilotError("DIRECTOR_PROPOSAL_TERMINAL", "该导演提案已结束，请读取当前版本", 409);
}
export async function finalizeDirectorAncestors(trx: Knex.Transaction, scope: Scope, proposalId: string, now: number) {
  const rows = await graph(trx, scope), ids = ancestors(rows, proposalId)
    .filter(id => ["DRAFT", "PREVIEWED"].includes(rows.get(id).status));
  if (ids.length) await trx("o_v04DirectorProposal").where(unit(scope)).whereIn("id", ids)
    .whereIn("status", ["DRAFT", "PREVIEWED"]).update({ status: "SUPERSEDED", updatedAt: now });
  return ids;
}
// Startup-only experimental repair: only proven ancestors of persisted
// accepted versions, never unrelated drafts. One atomic repair transaction.
export async function reconcileDirectorLineages(db: Knex) {
  return db.transaction(async trx => {
    const scopes = await trx("o_v04DirectorVersion").distinct("projectId", "scriptId");
    const repaired: { projectId: number; scriptId: number; proposalIds: string[] }[] = [];
    for (const scope of scopes) {
      const obsolete = await confirmedDirectorAncestors(trx, scope);
      const rows = obsolete.size ? await trx("o_v04DirectorProposal").where(scope)
        .whereIn("id", [...obsolete]).whereIn("status", ["DRAFT", "PREVIEWED"]).pluck("id") : [];
      if (!rows.length) continue;
      await trx("o_v04DirectorProposal").where(scope).whereIn("id", rows)
        .whereIn("status", ["DRAFT", "PREVIEWED"]).update({ status: "SUPERSEDED", updatedAt: Date.now() });
      repaired.push({ ...scope, proposalIds: rows });
    }
    return repaired;
  });
}

import type { Knex } from "knex";
import { ProfileError } from "./profileDefinition";

// SQLite writer serialization for revision-aware mutations. It must precede
// authorization/Gate reads in the same transaction, not just middleware.
export async function acquireRevisionBoundary(q: Knex.Transaction, projectId: number, scriptId: number) {
  const triggers = await q("sqlite_master").where({ type: "trigger", tbl_name: "o_script" }).select("sql");
  if (triggers.some(row => /\bUPDATE\b/i.test(String(row.sql ?? "")))) {
    throw new ProfileError("REVISION_RUNTIME_UNSAFE", "制作单元存在 UPDATE trigger，不能取得无副作用写入边界", 503);
  }
  const changed = await q("o_script").where({ id: scriptId, projectId })
    .update({ revisionEpoch: q.raw('"revisionEpoch"') });
  if (changed !== 1) throw new ProfileError("REVISION_SCOPE_INVALID", "制作单元不存在或不属于当前项目", 404);
}

export async function currentRevisionEpoch(q: Knex | Knex.Transaction, projectId: number, scriptId: number) {
  const script = await q("o_script").where({ id: scriptId, projectId }).first("revisionEpoch");
  if (!script) throw new ProfileError("REVISION_SCOPE_INVALID", "制作单元不存在或不属于当前项目", 404);
  const epoch = Number(script.revisionEpoch ?? 0);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ProfileError("REVISION_CONTEXT_INVALID", "制作单元修订代次无效", 409);
  return epoch;
}

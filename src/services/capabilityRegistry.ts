import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { CapabilityError, capabilityIdSchema, definitionHash, familyKeySchema, familySchema, validateBaseUrl, validateDefinition } from "./capabilityContract";

const db = () => u.db as Knex;
const endpointSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(256), baseUrl: z.string(), enabled: z.boolean() }).strict();
const versionFields = ["workflowJson", "inputPorts", "outputPorts", "inputMappings", "outputMappings", "endpointId", "runtimeConfig"] as const;
export function decodeVersion(row: any) {
  if (!row) return null;
  return { ...row, inputPorts: JSON.parse(row.inputPorts), outputPorts: JSON.parse(row.outputPorts),
    inputMappings: JSON.parse(row.inputMappings), outputMappings: JSON.parse(row.outputMappings), runtimeConfig: JSON.parse(row.runtimeConfig) };
}
function encodeDefinition(d: ReturnType<typeof validateDefinition>) {
  return { workflowJson: d.workflowJson, inputPorts: JSON.stringify(d.inputPorts), outputPorts: JSON.stringify(d.outputPorts), inputMappings: JSON.stringify(d.inputMappings), outputMappings: JSON.stringify(d.outputMappings), endpointId: d.endpointId, runtimeConfig: JSON.stringify(d.runtimeConfig) };
}
export async function listCapabilities() {
  const families = await db()("o_capability").orderBy("updatedAt", "desc");
  const versions = await db()("o_capabilityVersion").orderBy(["familyKey", { column: "version", order: "desc" }]);
  return families.map(f => ({ ...f, versions: versions.filter(v => v.familyKey === f.familyKey).map(v => ({ capabilityId: v.capabilityId, version: v.version, status: v.status, endpointId: v.endpointId, createdAt: v.createdAt, verifiedAt: v.verifiedAt, updatedAt: v.updatedAt })) }));
}
export async function createFamily(input: unknown) {
  const family = familySchema.parse(input), now = Date.now();
  try { await db()("o_capability").insert({ ...family, createdAt: now, updatedAt: now }); }
  catch (e: any) { if (String(e.code).includes("SQLITE_CONSTRAINT")) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Family Key 已存在", 409); throw e; }
  return db()("o_capability").where({ familyKey: family.familyKey }).first();
}
export async function updateFamily(input: unknown) {
  const family = familySchema.parse(input);
  if (!await db()("o_capability").where({ familyKey: family.familyKey }).update({ displayName: family.displayName, description: family.description, category: family.category, provider: family.provider, executorType: family.executorType, updatedAt: Date.now() })) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Capability Family 不存在", 404);
  return db()("o_capability").where({ familyKey: family.familyKey }).first();
}
export async function listEndpoints() { return db()("o_capabilityEndpoint").orderBy("createdAt", "asc"); }
export async function saveEndpoint(input: unknown) {
  let parsed: z.infer<typeof endpointSchema>;
  try { parsed = endpointSchema.parse(input); } catch { throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Endpoint 配置不合法"); }
  const baseUrl = validateBaseUrl(parsed.baseUrl), id = parsed.id ?? randomUUID(), now = Date.now();
  if (parsed.id) {
    if (!await db()("o_capabilityEndpoint").where({ id }).update({ name: parsed.name, baseUrl, enabled: parsed.enabled, updatedAt: now })) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Endpoint 不存在", 404);
  } else await db()("o_capabilityEndpoint").insert({ id, name: parsed.name, baseUrl, enabled: parsed.enabled, createdAt: now, updatedAt: now });
  return db()("o_capabilityEndpoint").where({ id }).first();
}
async function requireEndpoint(q: Knex | Knex.Transaction, id: string) {
  const endpoint = await q("o_capabilityEndpoint").where({ id }).first();
  if (!endpoint) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Endpoint 不存在");
  validateBaseUrl(endpoint.baseUrl); return endpoint;
}
export async function getVersion(input: unknown) {
  let capabilityId: string; try { capabilityId = capabilityIdSchema.parse(input); } catch { throw new CapabilityError("CAPABILITY_NOT_FOUND", "Capability ID 不合法", 404); }
  const row = await db()("o_capabilityVersion").where({ capabilityId }).first();
  if (!row) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Capability Version 不存在", 404);
  return decodeVersion(row)!;
}
export async function createVersion(input: { familyKey: string; sourceCapabilityId?: string; definition?: unknown }) {
  if (!z.object({ familyKey: familyKeySchema, sourceCapabilityId: capabilityIdSchema.optional(), definition: z.unknown().optional() }).strict().safeParse(input).success)
    throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "版本 ID 由 Family 自动分配，不接受手工覆盖");
  let familyKey: string; try { familyKey = familyKeySchema.parse(input.familyKey); } catch { throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Family Key 不合法"); }
  return db().transaction(async trx => {
    if (!await trx("o_capability").where({ familyKey }).first()) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Family 不存在", 404);
    const latest = await trx("o_capabilityVersion").where({ familyKey }).orderBy("version", "desc").first();
    const version = latest ? Number(latest.version) + 1 : 1;
    let source: any = null;
    if (input.sourceCapabilityId) {
      source = await trx("o_capabilityVersion").where({ capabilityId: input.sourceCapabilityId, familyKey }).first();
      if (!source) throw new CapabilityError("CAPABILITY_NOT_FOUND", "源版本不属于当前 Family", 404);
    }
    if (!source && input.definition === undefined) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "首版本请提供 Workflow、Port 与 Mapping");
    const sourceDefinition = source ? Object.fromEntries(versionFields.map(key => [key, key === "workflowJson" ? source[key] : key === "endpointId" ? source[key] : JSON.parse(source[key])])) : null;
    const draft = validateDefinition(input.definition ?? sourceDefinition);
    await requireEndpoint(trx, draft.endpointId);
    const capabilityId = `${familyKey}.v${version}`, now = Date.now();
    await trx("o_capabilityVersion").insert({ capabilityId, familyKey, version, status: "DRAFT", ...encodeDefinition(draft), createdAt: now, verifiedAt: null, updatedAt: now });
    return decodeVersion(await trx("o_capabilityVersion").where({ capabilityId }).first());
  });
}
export async function updateDraft(input: { capabilityId: string; definition: unknown }) {
  const version = await getVersion(input.capabilityId);
  if (version.status !== "DRAFT") throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "只有 Draft 可编辑；请创建新版本", 409);
  const d = validateDefinition(input.definition); await requireEndpoint(db(), d.endpointId);
  if (!await db()("o_capabilityVersion").where({ capabilityId: version.capabilityId, status: "DRAFT" }).update({ ...encodeDefinition(d), updatedAt: Date.now() })) throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "版本状态已改变，请刷新", 409);
  return getVersion(version.capabilityId);
}
export async function verifyVersion(input: { capabilityId: string }) {
  const version = await getVersion(input.capabilityId);
  if (version.status !== "DRAFT") throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "只有 Draft 可 Verify", 409);
  const latest = await db()("o_capabilityExecution").where({ capabilityId: version.capabilityId, status: "SUCCEEDED", definitionHash: definitionHash(version) }).orderBy("startedAt", "desc").first();
  if (!latest) throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "当前 Workflow/Mapping 尚未 Test Run 成功", 409);
  if (!await db()("o_capabilityVersion").where({ capabilityId: version.capabilityId, status: "DRAFT", updatedAt: version.updatedAt }).update({ status: "VERIFIED", verifiedAt: Date.now(), updatedAt: Date.now() })) throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "Draft 已被修改，请刷新", 409);
  return getVersion(version.capabilityId);
}
export async function disableVersion(input: { capabilityId: string }) {
  const version = await getVersion(input.capabilityId);
  if (version.status !== "VERIFIED") throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "只能 Disable 已验证版本", 409);
  if (!await db()("o_capabilityVersion").where({ capabilityId: version.capabilityId, status: "VERIFIED" }).update({ status: "DISABLED", updatedAt: Date.now() })) throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "版本状态已改变", 409);
  return getVersion(version.capabilityId);
}
export async function listExecutions(input: { capabilityId: string }) {
  const version = await getVersion(input.capabilityId);
  return db()("o_capabilityExecution").where({ capabilityId: version.capabilityId }).orderBy("startedAt", "desc").limit(50);
}
export async function readExecution(input: { executionId: string }) {
  let id: string; try { id = z.string().uuid().parse(input.executionId); } catch { throw new CapabilityError("CAPABILITY_NOT_FOUND", "Execution ID 不合法", 404); }
  const row = await db()("o_capabilityExecution").where({ executionId: id }).first();
  if (!row) throw new CapabilityError("CAPABILITY_NOT_FOUND", "Execution 不存在", 404);
  return { ...row, inputs: JSON.parse(row.inputs), outputs: JSON.parse(row.outputs), error: row.error ? JSON.parse(row.error) : null };
}
export { versionFields };

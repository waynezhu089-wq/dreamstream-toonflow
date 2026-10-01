import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { resolveProductionProfile } from "@/agents/productionAgent/profile";
import { definitionHash, positiveId, ProfileError, profileKeySchema, validateDefinition, versionLabel, versionNumber, type ProfileDefinition } from "./profileDefinition";

const db = () => u.db as Knex;
const familySchema = z.object({ profileKey: profileKeySchema, displayName: z.string().trim().min(1).max(256), description: z.string().trim().max(4000).default("") }).strict();
const versionInput = z.object({ profileKey: profileKeySchema, sourceVersion: z.string().optional(), definition: z.unknown().optional() }).strict();
const exactInput = z.object({ profileKey: profileKeySchema, version: z.string() }).strict();
const sourceSchema = z.enum(["MANUAL", "RECIPE"]);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Profile 请求字段不合法");
  return result.data;
}
function viewVersion(row: any) { return { ...row, version: versionLabel(Number(row.version)), definition: JSON.parse(row.definition) as ProfileDefinition }; }
async function family(q: Knex | Knex.Transaction, key: string) {
  const row = await q("o_productionProfile").where({ profileKey: key }).first();
  if (!row) throw new ProfileError("PROFILE_NOT_FOUND", "Production Profile 不存在", 404);
  return row;
}
async function exact(q: Knex | Knex.Transaction, key: string, version: number) {
  const row = await q("o_productionProfileVersion").where({ profileKey: key, version }).first();
  if (!row) throw new ProfileError("PROFILE_VERSION_NOT_FOUND", "Profile 精确版本不存在", 404);
  const definition = validateDefinition(JSON.parse(row.definition));
  if (definitionHash(definition) !== row.definitionHash) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Profile 定义已改变或校验失败", 409);
  return row;
}
export async function listProfiles() {
  const families = await db()("o_productionProfile").orderBy("updatedAt", "desc");
  const versions = await db()("o_productionProfileVersion").orderBy("version", "desc");
  return families.map(item => ({ ...item, versions: versions.filter(row => row.profileKey === item.profileKey).map(viewVersion) }));
}
export async function getProfile(input: unknown) {
  const value = parse(z.object({ profileKey: profileKeySchema, version: z.string().optional() }).strict(), input);
  const key = value.profileKey;
  const rows = value.version ? [await exact(db(), key, versionNumber(value.version))] : await db()("o_productionProfileVersion").where({ profileKey: key }).orderBy("version", "desc");
  return { family: await family(db(), key), versions: rows.map(viewVersion) };
}
export async function createFamily(input: unknown) {
  const value = parse(familySchema, input), now = Date.now();
  try { await db()("o_productionProfile").insert({ ...value, createdAt: now, updatedAt: now }); }
  catch (error: any) { if (String(error.code).includes("CONSTRAINT")) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Profile Key 已存在", 409); throw error; }
  return family(db(), value.profileKey);
}
export async function createVersion(input: unknown) {
  const value = parse(versionInput, input);
  try {
    return await db().transaction(async trx => {
      await family(trx, value.profileKey);
      const latest = await trx("o_productionProfileVersion").where({ profileKey: value.profileKey }).orderBy("version", "desc").first();
      const source = value.sourceVersion ? await exact(trx, value.profileKey, versionNumber(value.sourceVersion)) : latest;
      const definition = validateDefinition(value.definition ?? (source ? JSON.parse(source.definition) : undefined));
      const now = Date.now(), version = latest ? Number(latest.version) + 1 : 1;
      await trx("o_productionProfileVersion").insert({ profileKey: value.profileKey, version, status: "DRAFT", definition: JSON.stringify(definition), definitionHash: definitionHash(definition), createdAt: now, updatedAt: now, activatedAt: null, deprecatedAt: null });
      return viewVersion(await exact(trx, value.profileKey, version));
    });
  } catch (error: any) { if (String(error.code).includes("CONSTRAINT")) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Profile 版本发生并发变化，请刷新", 409); throw error; }
}
export async function editVersion(input: unknown) {
  const value = parse(exactInput.extend({ definition: z.unknown() }), input);
  const version = versionNumber(value.version), definition = validateDefinition(value.definition);
  return db().transaction(async trx => {
    await exact(trx, value.profileKey, version);
    const changed = await trx("o_productionProfileVersion").where({ profileKey: value.profileKey, version, status: "DRAFT" }).update({ definition: JSON.stringify(definition), definitionHash: definitionHash(definition), updatedAt: Date.now() });
    if (changed !== 1) throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "只有 Draft Profile Version 可编辑", 409);
    return viewVersion(await exact(trx, value.profileKey, version));
  });
}
export async function activateVersion(input: unknown) {
  const value = parse(exactInput, input), version = versionNumber(value.version);
  try {
    return await db().transaction(async trx => {
      const target = await exact(trx, value.profileKey, version);
      if (target.status !== "DRAFT") throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "只有 Draft Profile Version 可激活", 409);
      const now = Date.now();
      await trx("o_productionProfileVersion").where({ profileKey: value.profileKey, status: "ACTIVE" }).update({ status: "DEPRECATED", deprecatedAt: now, updatedAt: now });
      const changed = await trx("o_productionProfileVersion").where({ profileKey: value.profileKey, version, status: "DRAFT" }).update({ status: "ACTIVE", activatedAt: now, updatedAt: now });
      if (changed !== 1) throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "Profile 版本状态已变化，请刷新", 409);
      return viewVersion(await exact(trx, value.profileKey, version));
    });
  } catch (error: any) { if (String(error.code).includes("CONSTRAINT") || String(error.code).includes("SQLITE_BUSY")) throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "Profile 并发激活冲突，请刷新", 409); throw error; }
}
export async function deprecateVersion(input: unknown) {
  const value = parse(exactInput, input), version = versionNumber(value.version);
  return db().transaction(async trx => {
    const changed = await trx("o_productionProfileVersion").where({ profileKey: value.profileKey, version, status: "ACTIVE" }).update({ status: "DEPRECATED", deprecatedAt: Date.now(), updatedAt: Date.now() });
    if (changed !== 1) throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "只有 Active Profile Version 可弃用", 409);
    return viewVersion(await exact(trx, value.profileKey, version));
  });
}

export type ResolvedProfile = { managed: true; profileKey: string; version: string; status: string; source: "LEGACY_ADAPTER" | "MANUAL" | "RECIPE"; definition: ProfileDefinition; persisted: boolean } | { managed: false; profile: null; source: "UNMANAGED"; persisted: false };
export async function resolveProfile(input: unknown, q: Knex | Knex.Transaction = db()): Promise<ResolvedProfile> {
  const projectId = positiveId((input as any)?.projectId);
  const project = await q("o_project").where({ id: projectId }).first();
  if (!project) throw new ProfileError("PROFILE_SCOPE_INVALID", "项目不存在", 404);
  const binding = await q("o_projectProfileBinding").where({ projectId }).first();
  if (binding) {
    const row = await exact(q, binding.profileKey, Number(binding.profileVersion));
    if (row.status === "DRAFT") throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "项目不能使用 Draft Profile", 409);
    return { managed: true, profileKey: row.profileKey, version: versionLabel(Number(row.version)), status: row.status, source: binding.source, definition: JSON.parse(row.definition), persisted: true };
  }
  if (resolveProductionProfile(project).key !== "advertisement") return { managed: false, profile: null, source: "UNMANAGED", persisted: false };
  const row = await exact(q, "advertisement", 1);
  return { managed: true, profileKey: "advertisement", version: "v1", status: row.status, source: "LEGACY_ADAPTER", definition: JSON.parse(row.definition), persisted: false };
}
export async function bindProfile(input: unknown) {
  const value = parse(z.object({ projectId: z.number().int().positive(), profileKey: profileKeySchema, version: z.string(), source: sourceSchema.optional() }).strict(), input);
  const version = versionNumber(value.version), source = value.source ?? "MANUAL";
  if (source !== "MANUAL") throw new ProfileError("PROFILE_SCOPE_INVALID", "Recipe Profile 对齐只能通过 Recipe bind 事务完成");
  return db().transaction(async trx => {
    if (!await trx("o_project").where({ id: value.projectId }).first()) throw new ProfileError("PROFILE_SCOPE_INVALID", "项目不存在", 404);
    const target = await exact(trx, value.profileKey, version);
    const previous = await trx("o_projectProfileBinding").where({ projectId: value.projectId }).first();
    if (previous?.profileKey === value.profileKey && Number(previous.profileVersion) === version) return resolveProfile({ projectId: value.projectId }, trx);
    if (target.status !== "ACTIVE") throw new ProfileError("PROFILE_VERSION_NOT_ACTIVE", "新项目只能绑定 Active Profile Version", 409);
    if (await trx.schema.hasTable("o_projectRecipeBinding") && await trx("o_projectRecipeBinding").where({ projectId: value.projectId }).first()) throw new ProfileError("PROFILE_BINDING_LOCKED_BY_RECIPE", "请先移除当前 Recipe 绑定，再更换 Profile", 409);
    if (await trx("o_stageRun").where({ projectId: value.projectId }).first()) throw new ProfileError("PROFILE_BINDING_LOCKED", "已有 Stage 记录，不能直接更换 Profile", 409);
    const now = Date.now();
    await trx("o_projectProfileBinding").insert({ projectId: value.projectId, profileKey: value.profileKey, profileVersion: version, source, createdAt: now, updatedAt: now }).onConflict("projectId").merge({ profileKey: value.profileKey, profileVersion: version, source, updatedAt: now });
    return resolveProfile({ projectId: value.projectId }, trx);
  });
}
export async function adoptLegacy(input: unknown) {
  const projectId = positiveId((input as any)?.projectId);
  return db().transaction(async trx => {
    const resolved = await resolveProfile({ projectId }, trx);
    if (!resolved.managed || resolved.source !== "LEGACY_ADAPTER") throw new ProfileError("PROFILE_SCOPE_INVALID", "当前项目没有可 Adopt 的 Legacy Advertisement Profile", 409);
    if (resolved.persisted) return resolved;
    const now = Date.now();
    await trx("o_projectProfileBinding").insert({ projectId, profileKey: resolved.profileKey, profileVersion: versionNumber(resolved.version), source: "LEGACY_ADAPTER", createdAt: now, updatedAt: now }).onConflict("projectId").ignore();
    return resolveProfile({ projectId }, trx);
  });
}

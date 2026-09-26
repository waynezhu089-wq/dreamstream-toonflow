import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { recipeDefinitionSchema, recipeHash, recipeKeySchema, RecipeError, recipeVersionLabel, recipeVersionNumber, validateRecipeDefinition, type RecipeDefinition } from "./recipeContract";
import { resolveProfile } from "./orchestrator/profileRegistry";
import { definitionHash as profileHash, validateDefinition as validateProfileDefinition } from "./orchestrator/profileDefinition";

const db = () => u.db as Knex;
type Query = Knex | Knex.Transaction;
const keyInput = z.object({ recipeKey: recipeKeySchema, version: z.string() }).strict();
const familyInput = z.object({ recipeKey: recipeKeySchema, displayName: z.string().trim().min(1).max(256), description: z.string().trim().max(4000).default(""), tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]) }).strict();
const projectInput = z.object({ projectId: z.number().int().positive() }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new RecipeError("RECIPE_DEFINITION_INVALID", "Recipe 请求字段不合法"); return result.data; }
const isConflict = (error: any) => /SQLITE_CONSTRAINT|SQLITE_BUSY/.test(String(error?.code));
function viewFamily(row: any) { return { ...row, tags: JSON.parse(row.tags) }; }
function viewVersion(row: any) { return { ...row, version: recipeVersionLabel(Number(row.version)), definition: JSON.parse(row.definition) as RecipeDefinition }; }
async function family(q: Query, key: string) { const row = await q("o_recipe").where({ recipeKey: key }).first(); if (!row) throw new RecipeError("RECIPE_NOT_FOUND", "Recipe Family 不存在", 404); return row; }
async function exact(q: Query, key: string, version: number) {
  const row = await q("o_recipeVersion").where({ recipeKey: key, version }).first();
  if (!row) throw new RecipeError("RECIPE_VERSION_NOT_FOUND", "Recipe 精确版本不存在", 404);
  const definition = validateRecipeDefinition(JSON.parse(row.definition));
  if (recipeHash(definition) !== row.definitionHash) throw new RecipeError("RECIPE_HASH_MISMATCH", "Recipe 定义 Hash 与保存版本不一致", 409);
  return row;
}
async function dependencyHealth(q: Query, definition: RecipeDefinition) {
  const issues: string[] = [];
  const profile = await q("o_productionProfileVersion").where({ profileKey: definition.profileRef.profileKey, version: Number(definition.profileRef.profileVersion.slice(1)) }).first();
  if (!profile) issues.push("MISSING_DEPENDENCY");
  else if (profile.status !== "ACTIVE") issues.push("PROFILE_NOT_ACTIVE");
  let stages = new Set<string>();
  if (profile) {
    try {
      const definition = validateProfileDefinition(JSON.parse(profile.definition));
      stages = new Set(definition.stages.map(x => x.stageKey));
      if (profileHash(definition) !== profile.definitionHash) issues.push("DEFINITION_HASH_MISMATCH");
    } catch { issues.push("DEFINITION_HASH_MISMATCH"); }
  }
  for (const ref of definition.skillRefs) {
    const row = await q("o_skillVersion as v").join("o_skillRegistry as f", "v.skillId", "f.skillId").where({ "v.skillId": ref.skillId, "v.version": Number(ref.skillVersion.slice(1)) }).select("v.status", "f.skillType").first();
    if (!row) issues.push("MISSING_DEPENDENCY");
    else if (row.skillType !== ref.skillType) issues.push("SKILL_TYPE_MISMATCH");
    else if (row.status !== "ACTIVE") issues.push("SKILL_NOT_ACTIVE");
  }
  for (const ref of definition.capabilityRefs) {
    const row = await q("o_capabilityVersion").where({ capabilityId: ref.capabilityId }).first();
    if (!row) issues.push("MISSING_DEPENDENCY");
    else if (row.status !== "VERIFIED") issues.push("CAPABILITY_NOT_VERIFIED");
    if (ref.stageKey && profile && !stages.has(ref.stageKey)) issues.push("CAPABILITY_STAGE_INVALID");
  }
  return { healthy: issues.length === 0, issues: [...new Set(issues)] };
}
async function validateReferences(q: Query, definition: RecipeDefinition) {
  const profile = await q("o_productionProfileVersion").where({ profileKey: definition.profileRef.profileKey, version: Number(definition.profileRef.profileVersion.slice(1)) }).first();
  if (!profile) throw new RecipeError("RECIPE_DEFINITION_INVALID", "引用的精确 Profile Version 不存在");
  const stages = new Set((validateProfileDefinition(JSON.parse(profile.definition)).stages).map(s => s.stageKey));
  for (const ref of definition.skillRefs) {
    const row = await q("o_skillVersion as v").join("o_skillRegistry as f", "v.skillId", "f.skillId").where({ "v.skillId": ref.skillId, "v.version": Number(ref.skillVersion.slice(1)) }).select("f.skillType").first();
    if (!row || row.skillType !== ref.skillType) throw new RecipeError("RECIPE_DEFINITION_INVALID", "引用的 Skill 精确版本不存在或 Skill Type 不匹配");
  }
  for (const ref of definition.capabilityRefs) {
    if (!await q("o_capabilityVersion").where({ capabilityId: ref.capabilityId }).first()) throw new RecipeError("RECIPE_DEFINITION_INVALID", "引用的 Capability 精确版本不存在");
    if (ref.stageKey && !stages.has(ref.stageKey)) throw new RecipeError("RECIPE_DEFINITION_INVALID", "Capability Stage 不属于精确 Profile");
  }
}
async function inspectedVersion(q: Query, row: any) {
  const version = viewVersion(row);
  const health = await dependencyHealth(q, version.definition);
  if (recipeHash(version.definition) !== row.definitionHash) { health.healthy = false; health.issues.push("DEFINITION_HASH_MISMATCH"); }
  return { ...version, health };
}
export async function listRecipes() {
  const families = await db()("o_recipe").orderBy("updatedAt", "desc");
  const versions = await db()("o_recipeVersion").orderBy("version", "desc");
  return Promise.all(families.map(async row => ({ ...viewFamily(row), versions: await Promise.all(versions.filter(v => v.recipeKey === row.recipeKey).map(v => inspectedVersion(db(), v))) })));
}
export async function getRecipe(input: unknown) {
  const value = parse(z.object({ recipeKey: recipeKeySchema, version: z.string().optional() }).strict(), input);
  const versions = value.version ? await db()("o_recipeVersion").where({ recipeKey: value.recipeKey, version: recipeVersionNumber(value.version) }) : await db()("o_recipeVersion").where({ recipeKey: value.recipeKey }).orderBy("version", "desc");
  if (value.version && !versions.length) throw new RecipeError("RECIPE_VERSION_NOT_FOUND", "Recipe 精确版本不存在", 404);
  return { family: viewFamily(await family(db(), value.recipeKey)), versions: await Promise.all(versions.map(row => inspectedVersion(db(), row))) };
}
export async function createRecipeFamily(input: unknown) {
  const value = parse(familyInput, input), now = Date.now();
  try { await db()("o_recipe").insert({ ...value, tags: JSON.stringify(value.tags), createdAt: now, updatedAt: now }); }
  catch (error) { if (isConflict(error)) throw new RecipeError("RECIPE_DEFINITION_INVALID", "Recipe Key 已存在", 409); throw error; }
  return viewFamily(await family(db(), value.recipeKey));
}
export async function createRecipeVersion(input: unknown) {
  const value = parse(z.object({ recipeKey: recipeKeySchema, sourceVersion: z.string().optional(), definition: z.unknown().optional() }).strict(), input);
  try { return await db().transaction(async trx => {
    await family(trx, value.recipeKey);
    const latest = await trx("o_recipeVersion").where({ recipeKey: value.recipeKey }).orderBy("version", "desc").first();
    const source = value.sourceVersion ? await exact(trx, value.recipeKey, recipeVersionNumber(value.sourceVersion)) : latest;
    const definition = validateRecipeDefinition(value.definition ?? (source ? JSON.parse(source.definition) : undefined));
    await validateReferences(trx, definition);
    const version = latest ? Number(latest.version) + 1 : 1, now = Date.now();
    await trx("o_recipeVersion").insert({ recipeKey: value.recipeKey, version, status: "DRAFT", definition: JSON.stringify(definition), definitionHash: recipeHash(definition), createdAt: now, updatedAt: now, activatedAt: null, deprecatedAt: null });
    return inspectedVersion(trx, await exact(trx, value.recipeKey, version));
  }); } catch (error) { if (isConflict(error)) throw new RecipeError("RECIPE_BINDING_CONFLICT", "Recipe 版本并发变化，请刷新", 409); throw error; }
}
export async function editRecipeVersion(input: unknown) {
  const value = parse(keyInput.extend({ definition: z.unknown() }), input), version = recipeVersionNumber(value.version), definition = validateRecipeDefinition(value.definition);
  return db().transaction(async trx => {
    await exact(trx, value.recipeKey, version);
    await validateReferences(trx, definition);
    const changed = await trx("o_recipeVersion").where({ recipeKey: value.recipeKey, version, status: "DRAFT" }).update({ definition: JSON.stringify(definition), definitionHash: recipeHash(definition), updatedAt: Date.now() });
    if (changed !== 1) throw new RecipeError("RECIPE_VERSION_NOT_ACTIVE", "只有 Draft Recipe 可编辑", 409);
    return inspectedVersion(trx, await exact(trx, value.recipeKey, version));
  });
}
export async function activateRecipeVersion(input: unknown) {
  const value = parse(keyInput, input), version = recipeVersionNumber(value.version);
  try { return await db().transaction(async trx => {
    const row = await exact(trx, value.recipeKey, version), definition = validateRecipeDefinition(JSON.parse(row.definition));
    if (row.status !== "DRAFT") throw new RecipeError("RECIPE_VERSION_NOT_ACTIVE", "只有 Draft Recipe 可激活", 409);
    if (!(definition.skillRefs.length || definition.capabilityRefs.length || definition.assetPlanTemplate.length)) throw new RecipeError("RECIPE_DEFINITION_INVALID", "Recipe 至少需要一项可复用推荐");
    const health = await dependencyHealth(trx, definition);
    if (!health.healthy) throw new RecipeError("RECIPE_DEPENDENCY_NOT_ACTIVE", `依赖不可激活：${health.issues.join("、")}`, 409);
    const now = Date.now();
    await trx("o_recipeVersion").where({ recipeKey: value.recipeKey, status: "ACTIVE" }).update({ status: "DEPRECATED", deprecatedAt: now, updatedAt: now });
    const changed = await trx("o_recipeVersion").where({ recipeKey: value.recipeKey, version, status: "DRAFT" }).update({ status: "ACTIVE", activatedAt: now, updatedAt: now });
    if (changed !== 1) throw new RecipeError("RECIPE_BINDING_CONFLICT", "Recipe 激活状态已变化", 409);
    return inspectedVersion(trx, await exact(trx, value.recipeKey, version));
  }); } catch (error) { if (isConflict(error)) throw new RecipeError("RECIPE_BINDING_CONFLICT", "Recipe 并发激活冲突", 409); throw error; }
}
export async function deprecateRecipeVersion(input: unknown) {
  const value = parse(keyInput, input), version = recipeVersionNumber(value.version);
  return db().transaction(async trx => {
    const changed = await trx("o_recipeVersion").where({ recipeKey: value.recipeKey, version, status: "ACTIVE" }).update({ status: "DEPRECATED", deprecatedAt: Date.now(), updatedAt: Date.now() });
    if (changed !== 1) throw new RecipeError("RECIPE_VERSION_NOT_ACTIVE", "只有 Active Recipe 可弃用", 409);
    return inspectedVersion(trx, await exact(trx, value.recipeKey, version));
  });
}
async function project(q: Query, projectId: number) {
  const row = await q("o_project").where({ id: projectId }).first();
  if (!row) throw new RecipeError("RECIPE_SCOPE_INVALID", "项目不存在", 404);
  if (row.projectType !== "general_video") throw new RecipeError("RECIPE_SCOPE_INVALID", "Recipe 只可绑定视频制作项目", 409);
  return row;
}
async function binding(q: Query, projectId: number) { return q("o_projectRecipeBinding").where({ projectId }).first(); }
async function locked(q: Query, projectId: number) { return Boolean(await q("o_stageRun").where({ projectId }).first()); }
export async function resolveRecipe(input: unknown) {
  const { projectId } = parse(projectInput, input);
  await project(db(), projectId);
  const row = await binding(db(), projectId);
  if (!row) return { projectId, binding: null, profile: await resolveProfile({ projectId }), locked: await locked(db(), projectId) };
  const version = await exact(db(), row.recipeKey, Number(row.recipeVersion));
  if (version.definitionHash !== row.recipeDefinitionHash) throw new RecipeError("RECIPE_HASH_MISMATCH", "项目 Recipe 精确绑定 Hash 不一致", 409);
  const profile = await resolveProfile({ projectId });
  const required = validateRecipeDefinition(JSON.parse(version.definition)).profileRef;
  if (!profile.managed || !profile.persisted || profile.profileKey !== required.profileKey || profile.version !== required.profileVersion) throw new RecipeError("RECIPE_PROFILE_MISMATCH", "项目 Recipe 与精确 Profile 绑定不一致", 409);
  return { projectId, binding: { ...row, recipeVersion: recipeVersionLabel(Number(row.recipeVersion)) }, recipe: await inspectedVersion(db(), version), profile, locked: await locked(db(), projectId) };
}
async function inspectBind(q: Query, value: { projectId: number; recipeKey: string; version: string }) {
  await project(q, value.projectId);
  const current = await binding(q, value.projectId), hasRun = await locked(q, value.projectId);
  if (hasRun && (!current || current.recipeKey !== value.recipeKey || Number(current.recipeVersion) !== recipeVersionNumber(value.version))) throw new RecipeError("RECIPE_BINDING_LOCKED", "已有 Stage 记录，Recipe 绑定不可更换", 409);
  const row = await exact(q, value.recipeKey, recipeVersionNumber(value.version));
  if (row.status !== "ACTIVE") throw new RecipeError("RECIPE_VERSION_NOT_ACTIVE", "新绑定只允许 Active Recipe", 409);
  const definition = validateRecipeDefinition(JSON.parse(row.definition));
  const health = await dependencyHealth(q, definition);
  if (!health.healthy) throw new RecipeError("RECIPE_DEPENDENCY_STALE", `Recipe 依赖已变化：${health.issues.join("、")}`, 409);
  const profile = await q("o_projectProfileBinding").where({ projectId: value.projectId }).first();
  if (current && !profile) throw new RecipeError("RECIPE_PROFILE_MISMATCH", "现有 Recipe 缺少精确 Profile 绑定", 409);
  if (profile && (profile.profileKey !== definition.profileRef.profileKey || Number(profile.profileVersion) !== Number(definition.profileRef.profileVersion.slice(1)))) throw new RecipeError("RECIPE_PROFILE_MISMATCH", "项目已绑定不同的精确 Profile，需先调整项目 Profile", 409);
  if (!profile && hasRun) throw new RecipeError("RECIPE_BINDING_LOCKED", "已有 Stage 记录，不能建立新的 Profile 对齐", 409);
  return { row, definition, profile, current, alignmentRequired: !profile, hasRun };
}
export async function previewRecipeBind(input: unknown) {
  const value = parse(z.object({ projectId: z.number().int().positive(), recipeKey: recipeKeySchema, version: z.string() }).strict(), input);
  const result = await inspectBind(db(), value);
  return { projectId: value.projectId, recipeKey: value.recipeKey, version: value.version, recipeDefinitionHash: result.row.definitionHash, profileBefore: result.profile ? `${result.profile.profileKey}@${recipeVersionLabel(Number(result.profile.profileVersion))}` : null, profileAfter: `${result.definition.profileRef.profileKey}@${result.definition.profileRef.profileVersion}`, state: result.alignmentRequired ? "CAN_ALIGN_PROFILE" : "READY_TO_BIND", alignmentRequired: result.alignmentRequired, recommendations: { skills: result.definition.skillRefs, capabilities: result.definition.capabilityRefs, assetPlanTemplate: result.definition.assetPlanTemplate }, notice: "Recipe 是固定的可复用蓝图；推荐仅供审阅，001B 不会自动应用到生产。" };
}
export async function bindRecipe(input: unknown) {
  const value = parse(z.object({ projectId: z.number().int().positive(), recipeKey: recipeKeySchema, version: z.string(), confirmProfileAlignment: z.boolean().optional() }).strict(), input);
  const expected = await binding(db(), value.projectId);
  try { return await db().transaction(async trx => {
    const result = await inspectBind(trx, value);
    if ((expected?.recipeKey ?? null) !== (result.current?.recipeKey ?? null) || (expected?.recipeVersion ?? null) !== (result.current?.recipeVersion ?? null) || (expected?.updatedAt ?? null) !== (result.current?.updatedAt ?? null)) throw new RecipeError("RECIPE_BINDING_CONFLICT", "Recipe 绑定已被其他请求改变，请刷新", 409);
    if (result.alignmentRequired && value.confirmProfileAlignment !== true) throw new RecipeError("RECIPE_PROFILE_ALIGNMENT_REQUIRED", "绑定此 Recipe 将同时建立精确 Profile 绑定，请先确认", 409);
    const now = Date.now();
    if (result.alignmentRequired) await trx("o_projectProfileBinding").insert({ projectId: value.projectId, profileKey: result.definition.profileRef.profileKey, profileVersion: Number(result.definition.profileRef.profileVersion.slice(1)), source: "RECIPE", createdAt: now, updatedAt: now });
    // A same-version repeated bind is idempotent; a competing change fails on the expected current row.
    if (result.current) {
      const changed = await trx("o_projectRecipeBinding").where({ projectId: value.projectId, recipeKey: result.current.recipeKey, recipeVersion: result.current.recipeVersion, recipeDefinitionHash: result.current.recipeDefinitionHash, updatedAt: result.current.updatedAt }).update({ recipeKey: value.recipeKey, recipeVersion: recipeVersionNumber(value.version), recipeDefinitionHash: result.row.definitionHash, source: "MANUAL", updatedAt: now });
      if (changed !== 1) throw new RecipeError("RECIPE_BINDING_CONFLICT", "Recipe 绑定已被其他请求改变，请刷新", 409);
    } else await trx("o_projectRecipeBinding").insert({ projectId: value.projectId, recipeKey: value.recipeKey, recipeVersion: recipeVersionNumber(value.version), recipeDefinitionHash: result.row.definitionHash, source: "MANUAL", createdAt: now, updatedAt: now });
    return { projectId: value.projectId, recipeKey: value.recipeKey, version: value.version, recipeDefinitionHash: result.row.definitionHash, profile: result.definition.profileRef, alignedProfile: result.alignmentRequired };
  }); } catch (error) { if (isConflict(error)) throw new RecipeError("RECIPE_BINDING_CONFLICT", "Recipe 绑定发生并发冲突，请刷新", 409); throw error; }
}
export async function unbindRecipe(input: unknown) {
  const { projectId } = parse(projectInput, input);
  return db().transaction(async trx => {
    await project(trx, projectId);
    if (await locked(trx, projectId)) throw new RecipeError("RECIPE_BINDING_LOCKED", "已有 Stage 记录，Recipe 绑定不可移除", 409);
    await trx("o_projectRecipeBinding").where({ projectId }).delete();
    return { projectId, removed: true, profilePreserved: true };
  });
}
export async function resolveExactRecipeSkill(q: Query, projectId: number, recipeKey: string, recipeVersion: string, skillType: string) {
  const row = await binding(q, projectId);
  if (!row || row.recipeKey !== recipeKey || Number(row.recipeVersion) !== recipeVersionNumber(recipeVersion)) throw new RecipeError("RECIPE_CONTEXT_MISMATCH", "Recipe 上下文与项目精确绑定不一致", 409);
  const version = await exact(q, recipeKey, Number(row.recipeVersion));
  if (version.definitionHash !== row.recipeDefinitionHash) throw new RecipeError("RECIPE_HASH_MISMATCH", "Recipe 绑定 Hash 不一致", 409);
  const definition = validateRecipeDefinition(JSON.parse(version.definition));
  const profile = await q("o_projectProfileBinding").where({ projectId }).first();
  if (!profile || profile.profileKey !== definition.profileRef.profileKey || Number(profile.profileVersion) !== Number(definition.profileRef.profileVersion.slice(1))) throw new RecipeError("RECIPE_PROFILE_MISMATCH", "项目 Recipe 与 Profile 精确绑定不一致", 409);
  return definition.skillRefs.find(ref => ref.skillType === skillType) ?? null;
}

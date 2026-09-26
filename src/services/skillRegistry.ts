import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { canonicalScopeKey, definitionHash, emptyTemplate, renderRuntimeInstruction, scopeTypeSchema, SkillError, skillIdSchema, skillTypeSchema, sourceHash, templateFor, validateContent, versionLabel, versionNumber, type ScopeType, type SkillType } from "./skillContract";
import { recipeKeySchema, RecipeError, recipeVersionNumber } from "./recipeContract";
import { resolveExactRecipeSkill } from "./recipeRegistry";
import { resolveProfile } from "./orchestrator/profileRegistry";

const db = () => u.db as Knex;
const positive = z.number().int().positive();
const familyInput = z.object({ skillId: skillIdSchema, displayName: z.string().trim().min(1).max(256), skillType: skillTypeSchema, description: z.string().trim().max(4000).default(""), tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]) }).strict();
const bindingInput = z.object({ scopeType: scopeTypeSchema, scopeKey: z.string(), skillType: skillTypeSchema, skillId: skillIdSchema.nullable(), skillVersion: z.string().nullable(), overrideText: z.string().trim().max(4000).nullable() }).strict();
const contextInput = z.object({ projectId: positive, scriptId: positive, storyboardId: positive, profileKey: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(), recipeKey: recipeKeySchema.optional(), recipeVersion: z.string().optional() }).strict();
export type ResolveContext = z.infer<typeof contextInput>;

function parseJson(value: string) { return JSON.parse(value); }
function familyView(row: any) { return { ...row, tags: parseJson(row.tags) }; }
export function versionView(row: any) {
  return { ...row, version: versionLabel(Number(row.version)), content: parseJson(row.content), sourceData: parseJson(row.sourceData) };
}
function bindingView(row: any) { return { ...row, skillVersion: row.skillVersion == null ? null : versionLabel(Number(row.skillVersion)) }; }
async function requireFamily(q: Knex | Knex.Transaction, skillId: string) {
  const row = await q("o_skillRegistry").where({ skillId }).first();
  if (!row) throw new SkillError("SKILL_NOT_FOUND", "Skill 不存在", 404);
  return row;
}
async function requireVersion(q: Knex | Knex.Transaction, skillId: string, label: unknown) {
  const version = versionNumber(label);
  const row = await q("o_skillVersion").where({ skillId, version }).first();
  if (!row) throw new SkillError("SKILL_VERSION_NOT_FOUND", "指定 Skill Version 不存在", 404);
  return row;
}
export async function listSkills() {
  const families = await db()("o_skillRegistry").orderBy("updatedAt", "desc");
  const versions = await db()("o_skillVersion").select("skillId", "version", "status", "sourceType", "updatedAt").orderBy("version", "desc");
  return families.map(row => ({ ...familyView(row), versions: versions.filter(v => v.skillId === row.skillId).map(v => ({ ...v, version: versionLabel(Number(v.version)) })) }));
}
export async function getSkill(input: { skillId: string; version?: string }) {
  const skillId = skillIdSchema.parse(input.skillId);
  const family = familyView(await requireFamily(db(), skillId));
  const rows = input.version ? [await requireVersion(db(), skillId, input.version)] : await db()("o_skillVersion").where({ skillId }).orderBy("version", "desc");
  return { family, versions: rows.map(versionView) };
}
export async function createSkillFamily(input: unknown) {
  const family = familyInput.parse(input), now = Date.now();
  try { await db()("o_skillRegistry").insert({ ...family, tags: JSON.stringify(family.tags), createdAt: now, updatedAt: now }); }
  catch (error: any) { if (String(error.code).includes("SQLITE_CONSTRAINT")) throw new SkillError("SKILL_BINDING_INVALID", "Skill ID 已存在", 409); throw error; }
  return familyView(await requireFamily(db(), family.skillId));
}
export async function createDraft(input: { skillId: string; sourceVersion?: string; content?: unknown }) {
  if (!z.object({ skillId: skillIdSchema, sourceVersion: z.string().optional(), content: z.unknown().optional() }).strict().safeParse(input).success) throw new SkillError("SKILL_SOURCE_INVALID", "来源类型由对应 Builder 记录，不能自行声明");
  const skillId = skillIdSchema.parse(input.skillId);
  return db().transaction(async trx => {
    const family = await requireFamily(trx, skillId);
    const unfinished = await trx("o_skillVersion").where({ skillId, status: "DRAFT" }).orderBy("version", "desc").first();
    if (unfinished) throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", `已有 Draft ${versionLabel(Number(unfinished.version))} 正在编辑，请继续编辑它`, 409);
    const latest = await trx("o_skillVersion").where({ skillId }).orderBy("version", "desc").first();
    const next = latest ? Number(latest.version) + 1 : 1;
    const source = input.sourceVersion ? await requireVersion(trx, skillId, input.sourceVersion) : latest;
    const templateId = templateFor(family.skillType);
    const content = validateContent(family.skillType, templateId, input.content ?? (source ? parseJson(source.content) : emptyTemplate(family.skillType)));
    const sourceType = "MANUAL";
    const sourceData = source ? { copiedFromVersion: versionLabel(Number(source.version)), definitionHash: source.definitionHash } : {};
    const now = Date.now();
    await trx("o_skillVersion").insert({ skillId, version: next, status: "DRAFT", templateId, content: JSON.stringify(content), sourceType, sourceData: JSON.stringify(sourceData), definitionHash: definitionHash(templateId, content), createdAt: now, activatedAt: null, updatedAt: now });
    return versionView(await trx("o_skillVersion").where({ skillId, version: next }).first());
  });
}
export async function saveBuilderDraft(input: { family: unknown; content: unknown; sourceType: "MANUAL" | "PROJECT_DERIVED"; sourceData?: Record<string, unknown> }, transaction?: Knex.Transaction) {
  const family = familyInput.parse(input.family);
  const templateId = templateFor(family.skillType);
  const content = validateContent(family.skillType, templateId, input.content);
  const save = async (trx: Knex.Transaction) => {
    if (await trx("o_skillRegistry").where({ skillId: family.skillId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "Skill ID 已存在，请确认建议的新 ID", 409);
    const now = Date.now();
    await trx("o_skillRegistry").insert({ ...family, tags: JSON.stringify(family.tags), createdAt: now, updatedAt: now });
    await trx("o_skillVersion").insert({ skillId: family.skillId, version: 1, status: "DRAFT", templateId, content: JSON.stringify(content), sourceType: input.sourceType, sourceData: JSON.stringify(input.sourceData ?? {}), definitionHash: definitionHash(templateId, content), createdAt: now, activatedAt: null, updatedAt: now });
    return { family: familyView(await requireFamily(trx, family.skillId)), version: versionView(await requireVersion(trx, family.skillId, "v1")) };
  };
  return transaction ? save(transaction) : db().transaction(save);
}
export async function editDraft(input: { skillId: string; version: string; content: unknown }) {
  const skillId = skillIdSchema.parse(input.skillId);
  return db().transaction(async trx => {
    const family = await requireFamily(trx, skillId), row = await requireVersion(trx, skillId, input.version);
    if (row.status !== "DRAFT") throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", "已激活的版本不可修改；请创建 Draft V2", 409);
    const content = validateContent(family.skillType, row.templateId, input.content);
    await trx("o_skillVersion").where({ skillId, version: row.version, status: "DRAFT" }).update({ content: JSON.stringify(content), definitionHash: definitionHash(row.templateId, content), updatedAt: Date.now() });
    return versionView(await requireVersion(trx, skillId, input.version));
  });
}
export async function activateDraft(input: { skillId: string; version: string }) {
  const skillId = skillIdSchema.parse(input.skillId);
  return db().transaction(async trx => {
    const row = await requireVersion(trx, skillId, input.version);
    if (row.status !== "DRAFT") throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", "只有 Draft 可以激活", 409);
    const content = parseJson(row.content);
    if (!content.purpose?.trim() || !(content.rules?.length || content.outputRequirements?.length)) throw new SkillError("SKILL_TEMPLATE_INVALID", "激活前请填写用途及至少一条规则或输出要求");
    await trx("o_skillVersion").where({ skillId, status: "ACTIVE" }).update({ status: "DEPRECATED", updatedAt: Date.now() });
    const now = Date.now();
    await trx("o_skillVersion").where({ skillId, version: row.version, status: "DRAFT" }).update({ status: "ACTIVE", activatedAt: now, updatedAt: now });
    return versionView(await requireVersion(trx, skillId, input.version));
  });
}
export async function deprecateVersion(input: { skillId: string; version: string }) {
  const skillId = skillIdSchema.parse(input.skillId);
  const row = await requireVersion(db(), skillId, input.version);
  if (row.status !== "ACTIVE") throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", "只能弃用 Active 版本", 409);
  await db()("o_skillVersion").where({ skillId, version: row.version, status: "ACTIVE" }).update({ status: "DEPRECATED", updatedAt: Date.now() });
  return versionView(await requireVersion(db(), skillId, input.version));
}
// Runtime loader reads one exact row. Historical DEPRECATED versions remain legal.
export async function loadSkill(skillIdValue: string, versionValue: string, q: Knex | Knex.Transaction = db()) {
  const skillId = skillIdSchema.parse(skillIdValue);
  const row = await requireVersion(q, skillId, versionValue);
  if (row.status === "DRAFT") throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", "Draft 不可进入正式生产", 409);
  const family = await requireFamily(q, skillId), content = validateContent(family.skillType, row.templateId, parseJson(row.content));
  if (definitionHash(row.templateId, content) !== row.definitionHash) throw new SkillError("SKILL_TEMPLATE_INVALID", "Skill 定义校验失败", 409);
  return { skillId, skillVersion: versionLabel(Number(row.version)), skillStatus: row.status, skillType: family.skillType, definitionHash: row.definitionHash, content, runtimeInstruction: renderRuntimeInstruction(family.skillType, content) };
}
export async function previewVersion(input: { skillId: string; version: string }) {
  const row = await requireVersion(db(), skillIdSchema.parse(input.skillId), input.version);
  const family = await requireFamily(db(), row.skillId);
  return { version: versionView(row), runtimeInstruction: renderRuntimeInstruction(family.skillType, validateContent(family.skillType, row.templateId, parseJson(row.content))) };
}

async function assertScope(q: Knex | Knex.Transaction, type: ScopeType, key: string) {
  canonicalScopeKey(type, key);
  if (["SYSTEM", "PROFILE", "RECIPE"].includes(type)) return;
  const match = key.match(/^project:(\d+)(?::script:(\d+))?(?::(?:stage:([a-z][a-z0-9_-]*)|storyboard:(\d+)))?$/);
  if (!match) throw new SkillError("SKILL_BINDING_INVALID", "Scope Key 不符合规范");
  const projectId = Number(match[1]), scriptId = Number(match[2]), storyboardId = Number(match[4]);
  if (!await q("o_project").where({ id: projectId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "项目不存在", 404);
  if (type !== "PROJECT" && !await q("o_script").where({ id: scriptId, projectId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "制作单元不属于项目", 404);
  if (type === "SHOT" && !await q("o_storyboard").where({ id: storyboardId, projectId, scriptId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "镜头不属于制作单元", 404);
}
export async function saveBinding(input: unknown) {
  const value = bindingInput.parse(input);
  if (value.scopeType === "RECIPE") throw new SkillError("SKILL_BINDING_INVALID", "Recipe Skill 推荐请在 Recipe Draft 中编辑，不允许直接写绑定", 409);
  if ((value.skillId === null) !== (value.skillVersion === null) || (!value.skillId && !value.overrideText)) throw new SkillError("SKILL_BINDING_INVALID", "需要完整 Skill ID + Version，或填写 Override");
  if (value.skillVersion !== null) versionNumber(value.skillVersion);
  return db().transaction(async trx => {
    await assertScope(trx, value.scopeType, value.scopeKey);
    const key = { scopeType: value.scopeType, scopeKey: value.scopeKey, skillType: value.skillType };
    const previous = await trx("o_skillBinding").where(key).first();
    if (value.skillId) {
      const family = await requireFamily(trx, value.skillId), version = await requireVersion(trx, value.skillId, value.skillVersion);
      if (family.skillType !== value.skillType) throw new SkillError("SKILL_BINDING_INVALID", "Skill Type 不匹配");
      if (version.status === "DRAFT") throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", "Draft 不可绑定到生产", 409);
      if (version.status === "DEPRECATED" && !(previous?.skillId === value.skillId && previous?.skillVersion === version.version)) throw new SkillError("SKILL_DEPRECATED_NEW_BINDING_BLOCKED", "已弃用版本不可建立新绑定", 409);
    }
    const now = Date.now();
    await trx("o_skillBinding").insert({ ...key, skillId: value.skillId, skillVersion: value.skillVersion ? versionNumber(value.skillVersion) : null, overrideText: value.overrideText || null, createdAt: previous?.createdAt ?? now, updatedAt: now }).onConflict(["scopeType", "scopeKey", "skillType"]).merge(["skillId", "skillVersion", "overrideText", "updatedAt"]);
    return bindingView(await trx("o_skillBinding").where(key).first());
  });
}
export async function removeBinding(input: { scopeType: ScopeType; scopeKey: string; skillType: SkillType }) {
  const type = scopeTypeSchema.parse(input.scopeType), skillType = skillTypeSchema.parse(input.skillType), key = canonicalScopeKey(type, input.scopeKey);
  if (type === "RECIPE") throw new SkillError("SKILL_BINDING_INVALID", "Recipe Skill 绑定由 Recipe Version 管理", 409);
  await assertScope(db(), type, key);
  await db()("o_skillBinding").where({ scopeType: type, scopeKey: key, skillType }).delete();
  return { removed: true };
}
export async function listBindings(input: { scopeType?: ScopeType; scopeKey?: string; skillId?: string }) {
  const query = db()("o_skillBinding");
  if (input.scopeType || input.scopeKey) {
    if (!input.scopeType || !input.scopeKey) throw new SkillError("SKILL_BINDING_INVALID", "Scope Type 与 Key 必须同时提供");
    const type = scopeTypeSchema.parse(input.scopeType), key = canonicalScopeKey(type, input.scopeKey);
    await assertScope(db(), type, key); query.where({ scopeType: type, scopeKey: key });
  }
  if (input.skillId) query.where({ skillId: skillIdSchema.parse(input.skillId) });
  if (!input.scopeType && !input.skillId) throw new SkillError("SKILL_BINDING_INVALID", "请指定 Scope 或 Skill");
  return (await query.orderBy("updatedAt", "desc")).map(bindingView);
}

export async function resolveSkill(input: ResolveContext & { skillType: SkillType }, q: Knex | Knex.Transaction = db()) {
  const { skillType, ...scope } = z.object({ ...contextInput.shape, skillType: skillTypeSchema }).strict().parse(input);
  if (Boolean(scope.recipeKey) !== Boolean(scope.recipeVersion)) throw new SkillError("SKILL_RECIPE_CONTEXT_MISMATCH", "Recipe Key 与精确版本必须同时提供", 409);
  let recipeRef: { skillId: string; skillVersion: string } | null = null;
  if (scope.recipeKey && scope.recipeVersion) {
    try {
      recipeVersionNumber(scope.recipeVersion);
      recipeRef = await resolveExactRecipeSkill(q, scope.projectId, scope.recipeKey, scope.recipeVersion, skillType);
    } catch (error) {
      if (error instanceof RecipeError) throw new SkillError("SKILL_RECIPE_CONTEXT_MISMATCH", error.message, 409);
      throw error;
    }
  }
  const keys: { scopeType: ScopeType; scopeKey: string }[] = [
    { scopeType: "SYSTEM", scopeKey: "system" },
    ...(scope.profileKey ? [{ scopeType: "PROFILE" as const, scopeKey: `profile:${scope.profileKey}` }] : []),
    ...(scope.recipeKey ? [{ scopeType: "RECIPE" as const, scopeKey: `recipe:${scope.recipeKey}@${scope.recipeVersion}` }] : []),
    { scopeType: "PROJECT", scopeKey: `project:${scope.projectId}` },
    { scopeType: "STAGE", scopeKey: `project:${scope.projectId}:script:${scope.scriptId}:stage:${skillType === "IMAGE_PROMPT" ? "image-prompt" : skillType.toLowerCase().replaceAll("_", "-")}` },
    { scopeType: "SHOT", scopeKey: `project:${scope.projectId}:script:${scope.scriptId}:storyboard:${scope.storyboardId}` },
  ];
  await assertScope(q, "SHOT", keys.at(-1)!.scopeKey);
  const bindings = await q("o_skillBinding").where({ skillType }).whereIn("scopeKey", keys.map(k => k.scopeKey));
  const trace = keys.map(({ scopeType, scopeKey }) => {
    const row = scopeType === "RECIPE" ? (recipeRef ? { skillId: recipeRef.skillId, skillVersion: recipeVersionNumber(recipeRef.skillVersion), overrideText: null } : null) : bindings.find(b => b.scopeType === scopeType && b.scopeKey === scopeKey);
    return { scopeType, scopeKey, kind: !row ? "NONE" : row.skillId ? "EXACT_SKILL" : "OVERRIDE_ONLY", skillId: row?.skillId ?? null, skillVersion: row?.skillVersion == null ? null : versionLabel(Number(row.skillVersion)), overrideText: row?.overrideText ?? null };
  });
  const selected = [...trace].reverse().find(item => item.skillId && item.skillVersion);
  if (!selected) throw new SkillError("SKILL_RESOLUTION_FAILED", "当前镜头没有可解析的 Skill；请先人工绑定 Active 版本", 409);
  const loaded = await loadSkill(selected.skillId!, selected.skillVersion!, q);
  const overrideChain = trace.filter(item => item.overrideText).map(item => ({ scopeType: item.scopeType, scopeKey: item.scopeKey, text: item.overrideText! }));
  return { ...loaded, resolvedFrom: { scopeType: selected.scopeType, scopeKey: selected.scopeKey }, overrideChain,
    resolutionTrace: trace.map(item => ({ ...item, selected: item === selected, reason: item === selected ? "最高优先级的精确 Skill 绑定" : item.kind === "OVERRIDE_ONLY" ? "仅叠加局部 Override" : item.kind === "EXACT_SKILL" ? "被更高优先级精确绑定覆盖" : "此 Scope 无绑定" })) };
}

// Stage-level resolution is deliberately independent of the shot resolver: its
// context is obtained from the persisted control plane inside the caller's read
// transaction, and it never considers SHOT bindings.
export async function resolveStageSkill(q: Knex | Knex.Transaction, input: { projectId: number; scriptId: number; stageKey: string; skillType: SkillType }) {
  const { projectId, scriptId, stageKey, skillType } = input;
  if (!await q("o_script").where({ id: scriptId, projectId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "制作单元不属于当前项目", 404);
  const profile = await resolveProfile({ projectId }, q);
  if (!profile.managed || !profile.definition.stages.some(stage => stage.stageKey === stageKey)) throw new SkillError("SUPERVISOR_STAGE_NOT_AVAILABLE", "当前精确 Profile 没有此审核工序", 409);
  const recipeBinding = await q("o_projectRecipeBinding").where({ projectId }).first();
  const recipeRef = recipeBinding ? await resolveExactRecipeSkill(q, projectId, recipeBinding.recipeKey, `v${recipeBinding.recipeVersion}`, skillType) : null;
  const keys: { scopeType: ScopeType; scopeKey: string }[] = [
    { scopeType: "SYSTEM", scopeKey: "system" },
    { scopeType: "PROFILE", scopeKey: `profile:${profile.profileKey}` },
    ...(recipeBinding ? [{ scopeType: "RECIPE" as const, scopeKey: `recipe:${recipeBinding.recipeKey}` }] : []),
    { scopeType: "PROJECT", scopeKey: `project:${projectId}` },
    { scopeType: "STAGE", scopeKey: `project:${projectId}:script:${scriptId}:stage:${stageKey}` },
  ];
  const bindings = await q("o_skillBinding").where({ skillType }).whereIn("scopeKey", keys.map(key => key.scopeKey));
  const trace = keys.map(({ scopeType, scopeKey }) => {
    const row = scopeType === "RECIPE" ? recipeRef ? { skillId: recipeRef.skillId, skillVersion: versionNumber(recipeRef.skillVersion), overrideText: null } : null : bindings.find(binding => binding.scopeType === scopeType && binding.scopeKey === scopeKey);
    return { scopeType, scopeKey, kind: !row ? "NONE" : row.skillId ? "EXACT_SKILL" : "OVERRIDE_ONLY", skillId: row?.skillId ?? null, skillVersion: row?.skillVersion == null ? null : versionLabel(Number(row.skillVersion)), overrideText: row?.overrideText ?? null };
  });
  const selected = [...trace].reverse().find(item => item.skillId && item.skillVersion);
  if (!selected) throw new SkillError("SUPERVISOR_SKILL_NOT_RESOLVED", "当前工序尚未绑定可用的 Supervisor Skill", 409);
  const family = await requireFamily(q, selected.skillId!);
  const version = await requireVersion(q, selected.skillId!, selected.skillVersion!);
  if (family.skillType !== skillType || version.status === "DRAFT") throw new SkillError("SUPERVISOR_SKILL_NOT_RESOLVED", "Supervisor Skill 类型或版本不可用于生产", 409);
  const content = validateContent(family.skillType, version.templateId, parseJson(version.content));
  if (definitionHash(version.templateId, content) !== version.definitionHash) throw new SkillError("SUPERVISOR_SKILL_NOT_RESOLVED", "Supervisor Skill 定义校验失败", 409);
  const overrideChain = trace.filter(item => item.overrideText).map(item => ({ scopeType: item.scopeType, scopeKey: item.scopeKey, text: item.overrideText! }));
  return { skillId: selected.skillId!, skillVersion: selected.skillVersion!, skillStatus: version.status, skillType, definitionHash: version.definitionHash,
    runtimeInstruction: renderRuntimeInstruction(skillType, content), resolvedFrom: { scopeType: selected.scopeType, scopeKey: selected.scopeKey }, overrideChain,
    resolutionTrace: trace.map(item => ({ ...item, selected: item === selected, reason: item === selected ? "最高优先级的精确 Skill 绑定" : item.kind === "OVERRIDE_ONLY" ? "仅叠加局部 Override" : item.kind === "EXACT_SKILL" ? "被更高优先级精确绑定覆盖" : "此 Scope 无绑定" })) };
}

export async function recommendSkills(input: { skillType: SkillType; tags?: string[]; scene?: string; profileKey?: string; recipeKey?: string }) {
  const parsed = z.object({ skillType: skillTypeSchema, tags: z.array(z.string()).max(30).optional(), scene: z.string().max(200).optional(), profileKey: z.string().optional(), recipeKey: z.string().optional() }).strict().parse(input);
  const rows = await db()("o_skillRegistry as f").join("o_skillVersion as v", "f.skillId", "v.skillId").where({ "f.skillType": parsed.skillType, "v.status": "ACTIVE" }).select("f.*", "v.version", "v.content");
  const requested = new Set((parsed.tags ?? []).map(t => t.toLowerCase()));
  const candidates = rows.map(row => {
    const family = familyView(row), content = parseJson(row.content);
    const matchedTags = [...new Set([...family.tags, ...content.tags])].filter((t: string) => requested.has(t.toLowerCase()));
    const sceneMatch = Boolean(parsed.scene && content.applicableScenes.some((s: string) => s.toLowerCase() === parsed.scene!.toLowerCase()));
    const profileMatch = Boolean(parsed.profileKey && [...family.tags, ...content.tags].includes(`profile:${parsed.profileKey}`));
    const recipeMatch = Boolean(parsed.recipeKey && [...family.tags, ...content.tags].includes(`recipe:${parsed.recipeKey}`));
    const category = recipeMatch ? 4 : profileMatch ? 3 : sceneMatch ? 2 : matchedTags.length ? 1 : 0;
    return { skillId: family.skillId, displayName: family.displayName, skillVersion: versionLabel(Number(row.version)), skillType: family.skillType, tags: family.tags,
      reason: recipeMatch ? "匹配当前 Recipe 标签" : profileMatch ? "匹配当前 Profile 标签" : sceneMatch ? "匹配适用场景" : matchedTags.length ? `匹配标签：${matchedTags.join("、")}` : "同类型 Active Skill", category };
  }).sort((a, b) => b.category - a.category || a.skillId.localeCompare(b.skillId) || a.skillVersion.localeCompare(b.skillVersion));
  return { recommended: candidates[0] ? (({ category, ...value }) => value)(candidates[0]) : null,
    otherCompatibleSkills: candidates.slice(1).map(({ category, ...value }) => value) };
}

export async function copySkill(input: { sourceSkillId: string; sourceVersion: string; family: unknown }) {
  const family = familyInput.parse(input.family);
  const source = await requireVersion(db(), skillIdSchema.parse(input.sourceSkillId), input.sourceVersion);
  const sourceFamily = await requireFamily(db(), source.skillId);
  if (family.skillType !== sourceFamily.skillType || family.skillId === source.skillId) throw new SkillError("SKILL_TEMPLATE_INVALID", "Copy 必须创建同类型的新 Family");
  return db().transaction(async trx => {
    if (await trx("o_skillRegistry").where({ skillId: family.skillId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "目标 Skill ID 已存在", 409);
    const now = Date.now(), content = parseJson(source.content);
    await trx("o_skillRegistry").insert({ ...family, tags: JSON.stringify(family.tags), createdAt: now, updatedAt: now });
    await trx("o_skillVersion").insert({ skillId: family.skillId, version: 1, status: "DRAFT", templateId: source.templateId, content: source.content, sourceType: "COPY", sourceData: JSON.stringify({ sourceSkillId: source.skillId, sourceVersion: versionLabel(Number(source.version)), sourceHash: source.definitionHash, generatedAt: now }), definitionHash: definitionHash(source.templateId, content), createdAt: now, activatedAt: null, updatedAt: now });
    return { family: familyView(await requireFamily(trx, family.skillId)), version: versionView(await requireVersion(trx, family.skillId, "v1")) };
  });
}

export function sanitizeSelectedSource(value: string, projectName: string, assetNames: string[]) {
  let result = value.replace(/[A-Za-z]:\\[^\s"'，。]+|\/(?:[^\s"'，。\/]+\/){2,}[^\s"'，。]*/g, "[文件路径]")
    .replace(/\b(?:projectId|scriptId|storyboardId|assetId)\s*[:=]\s*\d+/gi, "[项目内部 ID]")
    .replace(/\b(?:SKU|sku)\s*[:=]?\s*[A-Za-z0-9_-]+/g, "[产品型号]");
  for (const name of [projectName, ...assetNames].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(name).join("[项目特有名称]");
  return result;
}
export async function readAndSanitizeSelectedSource(input: { projectId: number; scriptId: number; sourceType: "STORYBOARD_PROMPT" | "DIRECTOR_OUTPUT_SNAPSHOT" | "PRODUCTION_TEXT_RESULT"; sourceId: number }, q: Knex | Knex.Transaction = db()) {
  const ids = z.object({ projectId: positive, scriptId: positive, sourceId: positive }).parse(input);
  const script = await q("o_script").where({ id: ids.scriptId, projectId: ids.projectId }).first();
  const project = await q("o_project").where({ id: ids.projectId }).first();
  if (!project || !script) throw new SkillError("SKILL_SOURCE_INVALID", "来源制作单元不存在", 404);
  let snapshot: string;
  if (input.sourceType === "STORYBOARD_PROMPT") {
    const shot = await q("o_storyboard").where({ id: ids.sourceId, projectId: ids.projectId, scriptId: ids.scriptId }).first();
    if (!shot?.prompt) throw new SkillError("SKILL_SOURCE_INVALID", "指定镜头没有 Prompt", 404);
    snapshot = shot.prompt;
  } else if (["DIRECTOR_OUTPUT_SNAPSHOT", "PRODUCTION_TEXT_RESULT"].includes(input.sourceType)) {
    const row = await q("o_agentWorkData").where({ id: ids.sourceId, projectId: ids.projectId, episodesId: ids.scriptId, key: "productionAgent" }).first();
    if (!row) throw new SkillError("SKILL_SOURCE_INVALID", "指定生产工作区不存在", 404);
    let flow: any; try { flow = parseJson(row.data); } catch { throw new SkillError("SKILL_SOURCE_INVALID", "生产工作区内容不可读取"); }
    snapshot = input.sourceType === "DIRECTOR_OUTPUT_SNAPSHOT" ? flow.scriptPlan : flow.storyboardTable;
    if (typeof snapshot !== "string" || !snapshot.trim()) throw new SkillError("SKILL_SOURCE_INVALID", "所选来源没有文本内容", 404);
  } else throw new SkillError("SKILL_SOURCE_INVALID", "不支持的来源类型");
  const assetNames = (await q("o_assets").where({ projectId: ids.projectId }).pluck("name")).filter((v: any): v is string => typeof v === "string");
  const projectName = String(project.name ?? "");
  return { snapshot, safe: sanitizeSelectedSource(snapshot, projectName, assetNames), sourceHash: sourceHash(snapshot), projectName, assetNames };
}
export async function buildFromSelectedSource(input: { family: unknown; projectId: number; scriptId: number; sourceType: "STORYBOARD_PROMPT" | "DIRECTOR_OUTPUT_SNAPSHOT" | "PRODUCTION_TEXT_RESULT"; sourceId: number }) {
  const family = familyInput.parse(input.family);
  const { snapshot, safe } = await readAndSanitizeSelectedSource(input);
  const content = emptyTemplate(family.skillType);
  content.purpose = `从已选 ${input.sourceType} 提炼可复用的 ${family.skillType} 方法，需人工审阅后激活`;
  content.inputs = ["当前项目与镜头语义", "当前素材及真实性约束"];
  content.outputRequirements = ["输出可复用的方法，不复制来源项目的名称、ID、产品文字或文件路径"];
  const visual = content as ReturnType<typeof emptyTemplate> & Record<string, any>;
  // Subject names are deliberately not copied into a reusable public Skill.
  for (const [field, marker] of Object.entries({ composition: /(?:构图|composition)\s*[:：]\s*([^\n]+)/i, cameraLens: /(?:镜头|camera|lens)\s*[:：]\s*([^\n]+)/i, lighting: /(?:光线|lighting)\s*[:：]\s*([^\n]+)/i, color: /(?:色彩|color)\s*[:：]\s*([^\n]+)/i, style: /(?:风格|style)\s*[:：]\s*([^\n]+)/i })) {
    if (family.skillType === "IMAGE_PROMPT") visual[field] = safe.match(marker)?.[1]?.trim().slice(0, 2000) ?? "";
  }
  const now = Date.now();
  return db().transaction(async trx => {
    if (await trx("o_skillRegistry").where({ skillId: family.skillId }).first()) throw new SkillError("SKILL_BINDING_INVALID", "目标 Skill ID 已存在", 409);
    await trx("o_skillRegistry").insert({ ...family, tags: JSON.stringify(family.tags), createdAt: now, updatedAt: now });
    await trx("o_skillVersion").insert({ skillId: family.skillId, version: 1, status: "DRAFT", templateId: templateFor(family.skillType), content: JSON.stringify(content), sourceType: "PROJECT_DERIVED", sourceData: JSON.stringify({ sourceType: input.sourceType, sourceId: input.sourceId, sourceHash: sourceHash(snapshot), sourceSnapshot: snapshot, generatedAt: now }), definitionHash: definitionHash(templateFor(family.skillType), content), createdAt: now, activatedAt: null, updatedAt: now });
    return { family: familyView(await requireFamily(trx, family.skillId)), version: versionView(await requireVersion(trx, family.skillId, "v1")) };
  });
}

export async function checkReversePromptCompatibility() {
  const rows = await db()("o_capabilityVersion").where({ status: "VERIFIED" }).select("capabilityId", "inputPorts", "outputPorts");
  const compatible = rows.filter(row => {
    try { return parseJson(row.inputPorts).some((port: any) => port.type === "image") && parseJson(row.outputPorts).some((port: any) => port.type === "text"); }
    catch { return false; }
  });
  return { available: false, compatibleCapabilityIds: compatible.map(row => row.capabilityId), message: "当前没有可执行的 Reverse Prompt Capability：Generic Comfy Bridge 尚不支持 image → text" };
}
export async function requireReversePromptExecution() {
  await checkReversePromptCompatibility();
  throw new SkillError("REVERSE_PROMPT_CAPABILITY_UNSUPPORTED", "当前没有可执行的 Reverse Prompt Capability", 409);
}

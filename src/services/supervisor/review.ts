import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import u from "@/utils";
import { resolveProfile } from "@/services/orchestrator/profileRegistry";
import { ProfileError, versionNumber } from "@/services/orchestrator/profileDefinition";
import { recipeHash, validateRecipeDefinition } from "@/services/recipeContract";
import { canonicalJson, decisionSchema, scopeSchema, sha256, SupervisorError } from "./contract";
import { readTarget, reviewDefinition, reviewForGate } from "./registry";

type Query = Knex | Knex.Transaction;
const db = () => u.db as Knex;
function scope(input: unknown) {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) throw new SupervisorError("SUPERVISOR_SCOPE_INVALID", "请指定当前项目、制作单元与 Review 类型");
  return parsed.data;
}
async function current(q: Query, input: { projectId: number; scriptId: number; reviewKey: string }) {
  const { projectId, scriptId, reviewKey } = input;
  if (!await q("o_project").where({ id: projectId }).first() || !await q("o_script").where({ id: scriptId, projectId }).first()) throw new SupervisorError("SUPERVISOR_SCOPE_INVALID", "制作单元不存在或不属于当前项目", 404);
  const definition = reviewDefinition(reviewKey);
  let resolved: Awaited<ReturnType<typeof resolveProfile>>;
  try { resolved = await resolveProfile({ projectId }, q); }
  catch (error) {
    if (error instanceof ProfileError || error instanceof SyntaxError) throw new SupervisorError("SUPERVISOR_CONTEXT_UNAVAILABLE", "项目精确 Profile 上下文不存在或不一致", 409);
    throw error;
  }
  if (!resolved.managed) throw new SupervisorError("SUPERVISOR_CONTEXT_UNAVAILABLE", "当前项目没有可审核的精确 Profile", 409);
  const profile = { profileKey: resolved.profileKey, profileVersion: resolved.version };
  const binding = await q("o_projectRecipeBinding").where({ projectId }).first();
  let recipe: { recipeKey: string; recipeVersion: string; recipeDefinitionHash: string } | null = null;
  if (binding) {
    const exact = await q("o_recipeVersion").where({ recipeKey: binding.recipeKey, version: binding.recipeVersion }).first();
    if (!exact) throw new SupervisorError("SUPERVISOR_CONTEXT_UNAVAILABLE", "绑定的精确 Recipe 版本不存在", 409);
    let definition;
    try { definition = validateRecipeDefinition(JSON.parse(exact.definition)); }
    catch { throw new SupervisorError("SUPERVISOR_CONTEXT_UNAVAILABLE", "Recipe 定义无效", 409); }
    if (recipeHash(definition) !== exact.definitionHash || exact.definitionHash !== binding.recipeDefinitionHash || definition.profileRef.profileKey !== profile.profileKey || definition.profileRef.profileVersion !== profile.profileVersion || !resolved.persisted) throw new SupervisorError("SUPERVISOR_CONTEXT_UNAVAILABLE", "Recipe 与精确 Profile 上下文不一致", 409);
    recipe = { recipeKey: binding.recipeKey, recipeVersion: `v${Number(binding.recipeVersion)}`, recipeDefinitionHash: exact.definitionHash };
  }
  const target = await readTarget(q, reviewDefinition(reviewKey), projectId, scriptId);
  return { definition, profile, recipe, controlContextHash: sha256({ profile, recipe }), target };
}
function view(row: any, state: Awaited<ReturnType<typeof current>>) {
  const recipe = state.recipe;
  const current = row.targetHash === state.target.targetHash && row.controlContextHash === state.controlContextHash && row.profileKey === state.profile.profileKey && Number(row.profileVersion) === versionNumber(state.profile.profileVersion) &&
    row.recipeKey === (recipe?.recipeKey ?? null) && (row.recipeVersion === null ? null : Number(row.recipeVersion)) === (recipe ? Number(recipe.recipeVersion.slice(1)) : null) && row.recipeDefinitionHash === (recipe?.recipeDefinitionHash ?? null);
  return { ...row, profileVersion: `v${row.profileVersion}`, recipeVersion: row.recipeVersion === null ? null : `v${row.recipeVersion}`,
    targetSnapshot: JSON.parse(row.targetSnapshot), issues: JSON.parse(row.issues), status: current ? "CURRENT" : "STALE" };
}
async function rows(q: Query, ids: { projectId: number; scriptId: number; reviewKey: string }) {
  return q("o_supervisorReview").where(ids).orderBy("createdAt", "desc").orderBy("reviewId", "desc");
}
export async function targetRead(input: unknown) {
  const ids = scope(input);
  return db().transaction(async trx => {
    const state = await current(trx, ids);
    return { review: state.definition, target: state.target, profile: state.profile, recipe: state.recipe, controlContextHash: state.controlContextHash };
  });
}
export async function reviewHistory(input: unknown) {
  const ids = scope(input);
  return db().transaction(async trx => {
    const state = await current(trx, ids);
    return { review: state.definition, target: state.target, profile: state.profile, recipe: state.recipe, controlContextHash: state.controlContextHash,
      history: (await rows(trx, ids)).map(row => view(row, state)) };
  });
}
export async function decide(input: unknown, actor: unknown) {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) throw new SupervisorError("SUPERVISOR_DECISION_INVALID", "审核决定或字段不合法");
  const value = parsed.data;
  if (value.decision === "PASS" && value.issues.some(issue => issue.severity === "BLOCKER") || value.decision === "REVISE" && !value.issues.some(issue => issue.severity === "BLOCKER")) throw new SupervisorError("SUPERVISOR_DECISION_INVALID", "PASS 不得含阻塞项；REVISE 至少需一个阻塞项");
  const identity = actor as { id?: unknown; name?: unknown } | null;
  if (!identity || !Number.isSafeInteger(Number(identity.id)) || Number(identity.id) <= 0 || typeof identity.name !== "string" || !identity.name.trim()) throw new SupervisorError("SUPERVISOR_REVIEWER_CONTEXT_INVALID", "无法确认当前人工审核人", 401);
  const actorName = identity.name as string;
  try { return await db().transaction(async trx => {
    const state = await current(trx, value);
    if (state.target.targetHash !== value.expectedTargetHash) throw new SupervisorError("SUPERVISOR_TARGET_CHANGED", "分镜内容已变化，请刷新后重新审核", 409);
    if (state.controlContextHash !== value.expectedControlContextHash) throw new SupervisorError("SUPERVISOR_CONTEXT_CHANGED", "Profile 或 Recipe 上下文已变化，请刷新后重新审核", 409);
    const reviewId = randomUUID();
    const row = { reviewId, projectId: value.projectId, scriptId: value.scriptId, profileKey: state.profile.profileKey, profileVersion: versionNumber(state.profile.profileVersion),
      recipeKey: state.recipe?.recipeKey ?? null, recipeVersion: state.recipe ? Number(state.recipe.recipeVersion.slice(1)) : null, recipeDefinitionHash: state.recipe?.recipeDefinitionHash ?? null,
      reviewKey: value.reviewKey, targetAdapterKey: state.target.targetAdapterKey, targetType: state.target.targetType, targetHash: state.target.targetHash, controlContextHash: state.controlContextHash,
      targetSnapshot: canonicalJson(state.target.snapshot), decision: value.decision, source: "HUMAN", summary: value.summary, issues: canonicalJson(value.issues),
      supervisorSkillId: null, supervisorSkillVersion: null, supervisorSkillDefinitionHash: null, modelReference: null,
      actorUserId: Number(identity.id), actorDisplayName: actorName.trim().slice(0, 256), createdAt: Date.now() };
    await trx("o_supervisorReview").insert(row);
    return view(row, state);
  }); } catch (error: any) {
    if (error instanceof SupervisorError) throw error;
    if (/SQLITE_BUSY|SQLITE_CONSTRAINT/.test(String(error?.code))) throw new SupervisorError("SUPERVISOR_REVIEW_WRITE_CONFLICT", "审核记录写入发生并发冲突，请刷新后重试", 409);
    throw error;
  }
}
export async function resolveGate(input: unknown, expectedProfile?: { profileKey: string; profileVersion: string }) {
  const ids = scope(input);
  return db().transaction(async trx => {
    const state = await current(trx, ids);
    if (expectedProfile && (expectedProfile.profileKey !== state.profile.profileKey || expectedProfile.profileVersion !== state.profile.profileVersion)) throw new SupervisorError("SUPERVISOR_CONTEXT_CHANGED", "Stage Profile 与当前项目上下文不一致", 409);
    const history = (await rows(trx, ids)).map(row => view(row, state));
    const effective = history.find(row => row.status === "CURRENT" && row.source === "HUMAN" && ["PASS", "REVISE"].includes(row.decision)) ?? null;
    const base = { targetHash: state.target.targetHash, controlContextHash: state.controlContextHash, reviewKey: ids.reviewKey, effectiveDecision: effective?.decision ?? null, reviewId: effective?.reviewId ?? null, staleCount: history.filter(row => row.status === "STALE").length };
    if (!effective) return { ...base, pass: false, code: "SUPERVISOR_REVIEW_REQUIRED", reason: "当前分镜尚未经过人工审核" };
    if (effective.decision === "PASS") return { ...base, pass: true, code: "SUPERVISOR_PASS", reason: null };
    const blockers = effective.issues.filter((issue: any) => issue.severity === "BLOCKER").map((issue: any) => issue.message);
    return { ...base, pass: false, code: "SUPERVISOR_REVISE_REQUIRED", reason: blockers.join("；") || effective.summary };
  });
}
export async function gateCheck(input: unknown) {
  const ids = scope(input), definition = reviewDefinition(ids.reviewKey);
  return supervisorStageGate(definition.gateKey, ids);
}
export async function supervisorStageGate(gateKey: string, context: { projectId: number; scriptId: number; profileKey?: string; profileVersion?: string }) {
  const definition = reviewForGate(gateKey);
  try {
    return await resolveGate({ projectId: context.projectId, scriptId: context.scriptId, reviewKey: definition.reviewKey }, context.profileKey && context.profileVersion ? { profileKey: context.profileKey, profileVersion: context.profileVersion } : undefined);
  } catch (error) {
    const code = error instanceof SupervisorError ? error.code : "SUPERVISOR_TARGET_UNAVAILABLE";
    return { pass: false, code, reason: error instanceof SupervisorError ? error.message : "Supervisor Gate 暂时不可用", targetHash: null, controlContextHash: null };
  }
}

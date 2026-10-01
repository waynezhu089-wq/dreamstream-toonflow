import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { resolveProductionProfile } from "@/agents/productionAgent/profile";
import { ASSET_PLAN_TABLE, UPLOAD_SOURCE_TABLE } from "@/lib/advertisementAssetPlanSchema";
import { assertAssetPlanBinding, AssetPlanError, isManageableAssetPlanItem } from "./advertisementAssetPlan";
import { RecipeError } from "./recipeContract";
import { readExactRecipeRuntimeContext } from "./recipeRegistry";
import { sha256 } from "./supervisor/contract";

const db = () => u.db as Knex;
const id = z.number().int().positive().safe();
const scopeSchema = z.object({ projectId: id, scriptId: id }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const applySchema = scopeSchema.extend({ previewHash: hash, proposalContextHash: hash, proposedPlanHash: hash });
type Scope = z.infer<typeof scopeSchema>;
type PlanRow = { projectId: number; scriptId: number; assetKey: string; name: string; category: string;
  required: boolean; sourcePolicy: "REAL_REQUIRED" | "AI_ALLOWED"; assetId: number | null; position: number };

function invalid(): never { throw new RecipeError("RECIPE_TEMPLATE_PLAN_INVALID", "当前素材清单持久数据无效", 409); }
function integer(value: unknown, positive = false) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || typeof value !== "number" || (positive && n <= 0)) invalid();
  return n;
}
function normalize(row: any): PlanRow {
  if (!["assetKey", "name", "category"].every(key => typeof row[key] === "string") ||
      !["REAL_REQUIRED", "AI_ALLOWED"].includes(row.sourcePolicy) ||
      (row.required !== 0 && row.required !== 1)) invalid();
  return { projectId: integer(row.projectId, true), scriptId: integer(row.scriptId, true),
    assetKey: row.assetKey, name: row.name, category: row.category, required: Boolean(row.required),
    sourcePolicy: row.sourcePolicy, assetId: row.assetId == null ? null : integer(row.assetId, true),
    position: integer(row.position) };
}
function ordered(rows: PlanRow[]) { return [...rows].sort((a, b) => a.position - b.position ||
  (a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0)); }
function encode(row: PlanRow) { return { ...row, required: row.required ? 1 : 0 }; }
function planHash(scope: Scope, rows: PlanRow[]) { return sha256({ schemaVersion: 1, ...scope, rows: ordered(rows) }); }
async function rawPlan(q: Knex.Transaction, scope: Scope) {
  const raw = await q(ASSET_PLAN_TABLE).where(scope).orderBy("position", "asc").orderBy("assetKey", "asc").limit(201);
  if (raw.length > 200) throw new RecipeError("RECIPE_TEMPLATE_PLAN_INVALID", "素材清单超过预览上限", 409);
  return raw.map(normalize);
}
async function context(q: Knex.Transaction, scope: Scope) {
  const project = await q("o_project").where({ id: scope.projectId }).first();
  const script = await q("o_script").where({ id: scope.scriptId, projectId: scope.projectId }).first();
  if (!project || !script) throw new RecipeError("RECIPE_SCOPE_INVALID", "项目或制作单元不存在", 404);
  if (resolveProductionProfile(project).key !== "advertisement")
    throw new RecipeError("RECIPE_TEMPLATE_PROFILE_UNSUPPORTED", "当前 Profile 尚不支持素材模板应用", 409);
  const recipe = await readExactRecipeRuntimeContext(q, scope.projectId);
  if (!recipe) throw new RecipeError("RECIPE_NOT_BOUND", "请先绑定精确 Recipe", 409);
  if (recipe.profile.profileKey !== "advertisement")
    throw new RecipeError("RECIPE_TEMPLATE_PROFILE_UNSUPPORTED", "当前 Profile 尚不支持素材模板应用", 409);
  for (const item of recipe.definition.assetPlanTemplate) {
    if (!isManageableAssetPlanItem({ ...item, assetId: null })) invalid();
  }
  const proposalContextHash = sha256({ recipeKey: recipe.recipeKey, recipeVersion: recipe.recipeVersion,
    recipeDefinitionHash: recipe.recipeDefinitionHash, profile: recipe.profile });
  return { recipe, proposalContextHash };
}
function merge(scope: Scope, current: PlanRow[], template: Awaited<ReturnType<typeof context>>["recipe"]["definition"]["assetPlanTemplate"]) {
  const byKey = new Map(template.map(item => [item.assetKey, item]));
  const changes: any[] = [];
  const proposed = current.map(row => {
    const item = byKey.get(row.assetKey);
    if (!item) { changes.push({ assetKey: row.assetKey, kind: "PRESERVED", current: row, proposed: row }); return row; }
    const next = normalize(encode({ ...row, name: item.name, category: item.category,
      required: item.required, sourcePolicy: item.sourcePolicy }));
    changes.push({ assetKey: row.assetKey, kind: JSON.stringify(next) === JSON.stringify(row) ? "PRESERVED" : "MODIFIED",
      current: row, proposed: next });
    return next;
  });
  let position = Math.max(-1, ...current.map(row => row.position)) + 1;
  for (const item of template) if (!current.some(row => row.assetKey === item.assetKey)) {
    const next = normalize({ ...scope, ...item, required: item.required ? 1 : 0, assetId: null, position: position++ });
    proposed.push(next); changes.push({ assetKey: item.assetKey, kind: "ADDED", current: null, proposed: next });
  }
  if (proposed.length > 200) throw new RecipeError("RECIPE_TEMPLATE_PLAN_INVALID", "拟议清单超过上限", 409);
  return { proposed: ordered(proposed), changes };
}
async function bindingEvidence(q: Knex.Transaction, scope: Scope, proposed: PlanRow[]) {
  const bound = proposed.filter(row => row.assetId !== null);
  const assetIds = [...new Set(bound.map(row => row.assetId!))];
  if (!assetIds.length) return [];
  const assets = await q("o_assets").where({ projectId: scope.projectId }).whereIn("id", assetIds).select("id", "scriptId", "imageId");
  const links = await q("o_scriptAssets").where({ scriptId: scope.scriptId }).whereIn("assetId", assetIds).select("assetId");
  const imageIds = [...new Set(assets.map(row => row.imageId).filter((id): id is number => id != null))];
  const images = imageIds.length ? await q("o_image").whereIn("id", imageIds).select("id", "assetsId", "filePath", "state", "model") : [];
  const receipts = imageIds.length ? await q(UPLOAD_SOURCE_TABLE).where({ projectId: scope.projectId })
    .whereIn("assetId", assetIds).whereIn("imageId", imageIds).select("assetId", "imageId", "filePath", "uploadedAt").limit(201) : [];
  if (receipts.length > 200) throw new RecipeError("RECIPE_TEMPLATE_PLAN_INVALID", "上传凭据超过预览上限", 409);
  return bound.map(row => {
    const asset = assets.find(a => a.id === row.assetId);
    const image = images.find(i => i.id === asset?.imageId);
    const receipt = receipts.find(r => r.assetId === row.assetId && r.imageId === image?.id && r.filePath === image?.filePath);
    return { assetKey: row.assetKey, assetId: row.assetId, sourcePolicy: row.sourcePolicy,
      asset: asset ?? null, linked: links.some(link => link.assetId === row.assetId), image: image ?? null,
      receipt: receipt ?? null };
  });
}
async function plan(q: Knex.Transaction, scope: Scope, captured?: Awaited<ReturnType<typeof context>>, existing?: PlanRow[]) {
  const ctx = captured ?? await context(q, scope);
  const current = existing ?? await rawPlan(q, scope);
  const { proposed, changes } = merge(scope, current, ctx.recipe.definition.assetPlanTemplate);
  const conflicts: { assetKey: string; reason: string }[] = [];
  for (const row of proposed) if (row.assetId !== null) {
    try { await assertAssetPlanBinding(q, scope, row); }
    catch (error) {
      if (!(error instanceof AssetPlanError)) throw error;
      conflicts.push({ assetKey: row.assetKey, reason: error.code });
    }
  }
  const evidence = await bindingEvidence(q, scope, proposed);
  const currentPlanHash = planHash(scope, current), proposedPlanHash = planHash(scope, proposed);
  const previewHash = sha256({ schemaVersion: 1, ...scope, proposalContextHash: ctx.proposalContextHash,
    currentPlanHash, proposedPlanHash, template: ctx.recipe.definition.assetPlanTemplate,
    changes, conflicts, evidence });
  return { schemaVersion: 1, ...scope, previewHash, proposalContextHash: ctx.proposalContextHash,
    currentPlanHash, proposedPlanHash, proposedPlan: proposed, changes, conflicts, canApply: conflicts.length === 0 };
}
export async function previewRecipeAssetPlanTemplate(input: unknown) {
  const scope = scopeSchema.parse(input);
  return db().transaction(q => plan(q, scope));
}
export async function applyRecipeAssetPlanTemplate(input: unknown) {
  const request = applySchema.parse(input);
  const { projectId, scriptId, ...expected } = request, scope = { projectId, scriptId };
  return db().transaction(async q => {
    const ctx = await context(q, scope);
    if (ctx.proposalContextHash !== expected.proposalContextHash)
      throw new RecipeError("RECIPE_TEMPLATE_PREVIEW_STALE", "Recipe 或 Profile 已变化，请重新预览", 409);
    const current = await rawPlan(q, scope), currentPlanHash = planHash(scope, current);
    if (currentPlanHash === expected.proposedPlanHash)
      return { status: "ALREADY_APPLIED", resultPlanHash: currentPlanHash };
    const preview = await plan(q, scope, ctx, current);
    if (preview.conflicts.length) throw new RecipeError("RECIPE_TEMPLATE_BINDING_CONFLICT", "现有素材绑定与模板来源要求冲突", 409);
    if (preview.previewHash !== expected.previewHash || preview.proposalContextHash !== expected.proposalContextHash ||
        preview.proposedPlanHash !== expected.proposedPlanHash)
      throw new RecipeError("RECIPE_TEMPLATE_PREVIEW_STALE", "素材或模板已变化，请重新预览", 409);
    for (const row of preview.proposedPlan) {
      const old = current.find(item => item.assetKey === row.assetKey);
      if (!old) await q(ASSET_PLAN_TABLE).insert(encode(row));
      else if (JSON.stringify(old) !== JSON.stringify(row)) await q(ASSET_PLAN_TABLE)
        .where({ ...scope, assetKey: row.assetKey }).update({ name: row.name, category: row.category,
          required: row.required ? 1 : 0, sourcePolicy: row.sourcePolicy });
    }
    const resultPlanHash = planHash(scope, await rawPlan(q, scope));
    if (resultPlanHash !== expected.proposedPlanHash)
      throw new RecipeError("RECIPE_TEMPLATE_PREVIEW_STALE", "素材清单结果校验失败", 409);
    return { status: "APPLIED", resultPlanHash };
  });
}

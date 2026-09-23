import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { resolveProductionProfile } from "@/agents/productionAgent/profile";
import { ASSET_PLAN_TABLE, UPLOAD_SOURCE_TABLE } from "@/lib/advertisementAssetPlanSchema";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const assetKey = z.string().trim().min(1).max(128);
const contextSchema = z.object({ projectId: id, scriptId: id }).strict();
const itemSchema = z.object({
  assetKey,
  name: z.string().trim().min(1).max(256),
  category: z.string().trim().min(1).max(128),
  required: z.boolean(),
  sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]),
  assetId: id.nullable(),
}).strict();
const saveSchema = contextSchema.extend({ items: z.array(itemSchema).max(200) }).superRefine((plan, ctx) => {
  const keys = new Set<string>();
  plan.items.forEach((item, index) => {
    if (keys.has(item.assetKey)) ctx.addIssue({ code: "custom", path: ["items", index, "assetKey"], message: "assetKey 在当前计划中必须唯一" });
    keys.add(item.assetKey);
  });
});
const bindSchema = contextSchema.extend({ assetKey, assetId: id });
const unbindSchema = contextSchema.extend({ assetKey });
type Context = z.infer<typeof contextSchema>;
type Item = z.infer<typeof itemSchema>;
interface PlanRow extends Omit<Item, "required">, Context { required: number; position: number }

export class AssetPlanError extends Error {
  constructor(message: string, public code = "ASSET_PLAN_INVALID_CONTEXT", public status = 400) { super(message); }
}

async function assertContext(trx: Knex.Transaction, context: Context) {
  const project = await trx("o_project").where("id", context.projectId).first();
  if (!project || resolveProductionProfile(project).key !== "advertisement") throw new AssetPlanError("项目不存在或不是广告项目");
  const script = await trx("o_script").where({ id: context.scriptId, projectId: context.projectId }).first();
  if (!script) throw new AssetPlanError("制作单元不存在或不属于当前项目");
}

// Validate against the CURRENT asset/image, not its historical name, file
// extension, prompt or an earlier upload of a different image on the same asset.
export async function assertAssetPlanBinding(trx: Knex.Transaction, context: Context, item: Pick<Item, "assetId" | "sourcePolicy">) {
  const asset = await trx("o_assets").where({ id: item.assetId, projectId: context.projectId }).first();
  const linked = await trx("o_scriptAssets").where({ scriptId: context.scriptId, assetId: item.assetId }).first();
  if (!asset || !linked || (asset.scriptId != null && asset.scriptId !== context.scriptId)) {
    throw new AssetPlanError("资产不存在或未关联当前项目和制作单元", "ASSET_PLAN_ASSET_SCOPE_MISMATCH");
  }
  // AI_ALLOWED imposes no real-upload requirement on an otherwise valid local
  // asset (AI-created, uploaded, or not generated yet). Gate readiness is separate.
  if (item.sourcePolicy === "AI_ALLOWED") return;
  const image = asset.imageId == null ? undefined : await trx("o_image").where({ id: asset.imageId, assetsId: asset.id }).first();
  const receipt = image?.filePath && image.state === "已完成" && !image.model
    ? await trx(UPLOAD_SOURCE_TABLE).where({ projectId: context.projectId, assetId: asset.id, imageId: image.id, filePath: image.filePath }).first()
    : undefined;
  if (!receipt) throw new AssetPlanError("REAL_REQUIRED 只能绑定当前文件具有服务器上传来源凭据的资产", "ASSET_PLAN_REAL_SOURCE_REQUIRED", 409);
}

async function view(trx: Knex.Transaction, context: Context) {
  const rows = await trx<PlanRow>(ASSET_PLAN_TABLE).where(context).orderBy("position", "asc");
  const items = [];
  for (const row of rows) {
    const item: Item = { assetKey: row.assetKey, name: row.name, category: row.category, required: Boolean(row.required), sourcePolicy: row.sourcePolicy, assetId: row.assetId };
    let bindingIssue: string | null = item.assetId === null ? "UNBOUND" : null;
    if (item.assetId !== null) {
      try { await assertAssetPlanBinding(trx, context, item); }
      catch (error) {
        if (!(error instanceof AssetPlanError)) throw error;
        bindingIssue = error.code;
      }
    }
    // If a bound asset is later deleted/relinked/regenerated, do not silently
    // report it as a valid real binding. Reads do not mutate plans or Gate state.
    items.push({ ...item, bindingValid: bindingIssue === null, bindingIssue });
  }
  return { ...context, items };
}

function database() { return u.db as Knex; }

// Gate shares the exact binding validation in the same SQLite read transaction.
export async function readAssetPlanInTransaction(trx: Knex.Transaction, input: unknown) {
  const context = contextSchema.parse(input);
  await assertContext(trx, context);
  return view(trx, context);
}

export async function readAssetPlan(input: unknown) {
  const context = contextSchema.parse(input);
  return database().transaction(trx => readAssetPlanInTransaction(trx, context));
}

export async function saveAssetPlan(input: unknown) {
  const { items, ...context } = saveSchema.parse(input);
  return database().transaction(async (trx) => {
    await assertContext(trx, context);
    // Validate every proposed binding before replacing any part of the plan.
    for (const item of items) if (item.assetId !== null) await assertAssetPlanBinding(trx, context, item);
    await trx(ASSET_PLAN_TABLE).where(context).whereNotIn("assetKey", items.map(item => item.assetKey)).delete();
    for (const [position, item] of items.entries()) {
      await trx<PlanRow>(ASSET_PLAN_TABLE)
        .insert({ ...context, ...item, required: item.required ? 1 : 0, position })
        .onConflict(["projectId", "scriptId", "assetKey"])
        .merge(["name", "category", "required", "sourcePolicy", "assetId", "position"]);
    }
    return view(trx, context);
  });
}

export async function bindAssetPlanItem(input: unknown) {
  const { assetKey, assetId, ...context } = bindSchema.parse(input);
  return database().transaction(async (trx) => {
    await assertContext(trx, context);
    const item = await trx<PlanRow>(ASSET_PLAN_TABLE).where({ ...context, assetKey }).first();
    if (!item) throw new AssetPlanError("当前制作单元中没有该计划项", "ASSET_PLAN_ITEM_NOT_FOUND", 404);
    await assertAssetPlanBinding(trx, context, { assetId, sourcePolicy: item.sourcePolicy });
    await trx(ASSET_PLAN_TABLE).where({ ...context, assetKey }).update({ assetId });
    return view(trx, context);
  });
}

export async function unbindAssetPlanItem(input: unknown) {
  const { assetKey, ...context } = unbindSchema.parse(input);
  return database().transaction(async (trx) => {
    await assertContext(trx, context);
    const item = await trx(ASSET_PLAN_TABLE).where({ ...context, assetKey }).first();
    if (!item) throw new AssetPlanError("当前制作单元中没有该计划项", "ASSET_PLAN_ITEM_NOT_FOUND", 404);
    await trx(ASSET_PLAN_TABLE).where({ ...context, assetKey }).update({ assetId: null });
    return view(trx, context);
  });
}

import u from "@/utils";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { Knex } from "knex";
export const slotNames = ["text", "image", "video", "tts"] as const;
export type Slot = typeof slotNames[number];
export type Slots = Record<Slot, string | null>;
const model = z.string().trim().regex(/^[^:]+:.+$/).nullable();
export const slotsSchema = z.object({ text: model, image: model, video: model, tts: model }).strict();
export const patchSchema = slotsSchema.partial();
export const emptySlots = (): Slots => ({ text: null, image: null, video: null, tts: null });
const db = () => u.db as Knex;
export const isAdvertisement = (p: any) => p?.projectType === "general_video" && p?.type === "advertisement";
export class ModelConfigError extends Error { constructor(message: string, public status = 400) { super(message); } }
function parse(row: any): Slots { return { ...emptySlots(), ...JSON.parse(row?.slots || "{}") }; }
async function scopeModels(scope: string, q: Knex | Knex.Transaction): Promise<Slots> {
  const row = await q("o_modelScope").where({ scope }).first();
  const preset = row?.presetId ? await q("o_modelPreset").where({ id: row.presetId }).first() : null;
  const own = parse(row), inherited = parse(preset);
  return Object.fromEntries(slotNames.map(s => [s, own[s] ?? inherited[s]])) as Slots;
}
export async function resolveModels(projectId: number) {
  const q = db();
  const project = await q("o_project").where({ id: projectId }).first();
  if (!project) throw new ModelConfigError("项目不存在", 404);
  const legacy = { ...emptySlots(), image: project.imageModel || null, video: project.videoModel || null };
  if (!isAdvertisement(project)) return { models: legacy, sources: { text: "legacy", image: "legacy", video: "legacy", tts: "legacy" }, overrides: legacy };
  return q.transaction(async trx => {
    const row = await trx("o_modelScope").where({ scope: `project:${projectId}` }).first();
    // Legacy project fields remain readable until a slot is explicitly migrated.
    const stored = JSON.parse(row?.slots || "{}");
    const own = Object.fromEntries(slotNames.map(s => [s, Object.hasOwn(stored, s) ? stored[s] : legacy[s]])) as Slots;
    const profile = await scopeModels("profile:advertisement", trx);
    const system = await scopeModels("system", trx);
    return {
      models: Object.fromEntries(slotNames.map(s => [s, own[s] ?? profile[s] ?? system[s]])) as Slots,
      sources: Object.fromEntries(slotNames.map(s => [s, own[s] ? "project" : profile[s] ? "profile" : system[s] ? "system" : "none"])),
      overrides: own,
    };
  });
}
export async function listConfiguration() {
  const options: { value: string; label: string; type: Slot }[] = [];
  for (const vendor of await db()("o_vendorConfig").where({ enable: 1 })) {
    try { for (const m of await u.vendor.getModelList(String(vendor.id))) if (slotNames.includes(m.type)) options.push({ value: String(vendor.id) + ":" + m.modelName, label: m.name || m.modelName, type: m.type }); } catch { /* Unreadable vendors cannot supply selectable models. */ }
  }
  return { options, presets: (await db()("o_modelPreset").select("*")).map(p => ({ id: p.id, name: p.name, slots: parse(p) })), scopes: await db()("o_modelScope").whereIn("scope", ["system", "profile:advertisement"]).select("scope", "presetId") };
}
export async function savePreset(input: unknown) {
  const data = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), slots: slotsSchema }).strict().parse(input);
  const id = data.id ?? randomUUID();
  if (data.id && !await db()("o_modelPreset").where({ id }).first()) throw new ModelConfigError("预设不存在", 404);
  await db()("o_modelPreset").insert({ id, name: data.name, slots: JSON.stringify(data.slots) }).onConflict("id").merge();
  return { ...data, id };
}
export async function setDefault(input: unknown) {
  const { scope, presetId } = z.object({ scope: z.enum(["system", "profile:advertisement"]), presetId: z.string().uuid().nullable() }).strict().parse(input);
  if (presetId && !await db()("o_modelPreset").where({ id: presetId }).first()) throw new ModelConfigError("预设不存在", 404);
  await db()("o_modelScope").insert({ scope, presetId, slots: "{}" }).onConflict("scope").merge();
  return listConfiguration();
}
export async function patchProject(input: unknown) {
  const { projectId, slots, presetId } = z.object({ projectId: z.number().int().positive(), slots: patchSchema.optional(), presetId: z.string().uuid().optional() }).strict().parse(input);
  if ((slots === undefined) === (presetId === undefined)) throw new ModelConfigError("请选择整套预设或单项修改");
  await db().transaction(async trx => {
    const project = await trx("o_project").where({ id: projectId }).first();
    if (!isAdvertisement(project)) throw new ModelConfigError("当前项目不支持广告模型覆盖");
    const preset = presetId ? await trx("o_modelPreset").where({ id: presetId }).first() : null;
    if (presetId && !preset) throw new ModelConfigError("预设不存在", 404);
    const scope = `project:${projectId}`;
    const row = await trx("o_modelScope").where({ scope }).first();
    const next = { ...JSON.parse(row?.slots || "{}"), ...(preset ? parse(preset) : slots) };
    await trx("o_modelScope").insert({ scope, presetId: null, slots: JSON.stringify(next) }).onConflict("scope").merge();
    // Keep legacy consumers compatible, without copying inherited defaults.
    const fields: Record<string, string> = {};
    for (const s of ["image", "video"] as const) if (preset || Object.hasOwn(slots!, s)) fields[`${s}Model`] = next[s] ?? "";
    if (Object.keys(fields).length) await trx("o_project").where({ id: projectId }).update(fields);
  });
  return resolveModels(projectId);
}
export async function requireModel(projectId: number, slot: Slot, legacyValue = "") {
  const project = await db()("o_project").where({ id: projectId }).first();
  if (!project) throw new ModelConfigError("项目不存在", 404);
  if (!isAdvertisement(project)) return legacyValue;
  const value = (await resolveModels(projectId)).models[slot];
  const label = { text: "文本", image: "图片生成", video: "视频生成", tts: "音频/TTS" }[slot];
  const missing = () => new ModelConfigError(`请先配置${label}模型（项目模型配置或设置中的模型预设）`, 409);
  if (!value) throw missing();
  const [id, name] = value.split(/:(.+)/);
  const vendor = await db()("o_vendorConfig").where({ id, enable: 1 }).first();
  if (!vendor) throw missing();
  let models;
  try { models = await u.vendor.getModelList(id); } catch { throw missing(); }
  if (!models.some((m: any) => m.modelName === name && m.type === slot)) throw missing();
  return value;
}

// Preserve existing per-agent text deployment when no preset supplies text.
export async function textModelForProject(projectId: number, legacyKey: string) {
  const { models } = await resolveModels(projectId);
  return models.text ? requireModel(projectId, "text", legacyKey) : legacyKey;
}

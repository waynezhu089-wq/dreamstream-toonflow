import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { db } from "@/utils/db";
import { assertAssetPlanBinding, readAssetPlanInTransaction } from "@/services/advertisementAssetPlan";
import { ASSET_PLAN_TABLE } from "@/lib/advertisementAssetPlanSchema";

export class PilotError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const id = z.number().int().positive();
const scope = z.object({ projectId: id, scriptId: id }).strict();
const text = z.string().max(30000);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const q = db as Knex;
const category = z.enum(["CHAR", "ACC", "PROP", "PRODUCT", "LOC", "BRAND", "UI", "FX"]);
const newAsset = z.object({
  name: z.string().trim().min(1).max(256), category,
  description: z.string().max(4000).default(""),
  identityAnchors: z.array(z.string().max(300)).max(30).default([]),
  mustPreserve: z.array(z.string().max(300)).max(30).default([]),
  forbiddenChanges: z.array(z.string().max(300)).max(30).default([]),
  ownerKey: z.string().max(128).nullable().default(null),
  variantOf: z.string().max(128).nullable().default(null),
  sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]).default("AI_ALLOWED"),
  prompt: z.string().max(8000).default(""),
}).strict();
const assetChange = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("ADD"), clientRef: z.string().min(1).max(80), asset: newAsset }).strict(),
  z.object({ operation: z.literal("EDIT"), canonicalKey: z.string().min(1).max(128), expectedRevision: id, patch: newAsset.partial() }).strict(),
  z.object({ operation: z.literal("RETIRE"), canonicalKey: z.string().min(1).max(128), expectedRevision: id }).strict(),
]);
const assetRequest = scope.extend({ changes: z.array(assetChange).min(1).max(100), sourceCreativeVersion: id.optional(), previewHash: z.string().length(64).optional() });
const creativeRequest = scope.extend({ brief: text, treatment: text, script: text, targetDuration: z.number().int().min(1).max(600), expectedVersion: id, previewHash: z.string().length(64).optional() });

async function checkedScope(trx: Knex.Transaction, input: z.infer<typeof scope>) {
  const [project, unit] = await Promise.all([
    trx("o_project").where({ id: input.projectId }).first(),
    trx("o_script").where({ id: input.scriptId, projectId: input.projectId }).first(),
  ]);
  if (!project || !unit) throw new PilotError("PILOT_SCOPE_INVALID", "项目或制作单元不存在", 404);
  if (project.projectType !== "general_video" || project.type !== "advertisement") throw new PilotError("PILOT_PROFILE_UNSUPPORTED", "实验版目前仅支持广告", 409);
  return { project, unit };
}

export async function createPilotProject(input: unknown, actorUserId: number) {
  const data = z.object({ name: z.string().trim().min(1).max(200), brief: text, targetDuration: z.number().int().min(1).max(600), aspectRatio: z.enum(["16:9", "9:16", "1:1"]) }).strict().parse(input);
  return q.transaction(async trx => {
    const projectId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const profile = await trx("o_productionProfileVersion").where({ profileKey: "advertisement", version: 2, status: "ACTIVE" }).first();
    if (!profile) throw new PilotError("PILOT_PROFILE_UNAVAILABLE", "实验版受控生产工艺尚未初始化", 503);
    await trx("o_project").insert({ id: projectId, projectType: "general_video", type: "advertisement", name: data.name, intro: data.brief, artStyle: "", directorManual: "", videoRatio: data.aspectRatio, imageModel: "", videoModel: "", imageQuality: "", mode: "", userId: actorUserId, createTime: Date.now() });
    await trx("o_projectProfileBinding").insert({ projectId, profileKey: "advertisement", profileVersion: 2, source: "MANUAL", createdAt: Date.now(), updatedAt: Date.now() });
    const [scriptId] = await trx("o_script").insert({ projectId, name: "广告制作单元", content: "", createTime: Date.now() });
    await trx("o_v04Creative").insert({ projectId, scriptId, brief: data.brief, treatment: "", script: "", targetDuration: data.targetDuration, aspectRatio: data.aspectRatio, version: 1, updatedAt: Date.now() });
    return { projectId, scriptId };
  });
}
export async function listPilotProjects(actorUserId: number) {
  return q("o_v04Creative as c").join("o_project as p", "p.id", "c.projectId")
    .where("p.userId", actorUserId).select("c.projectId", "c.scriptId", "c.targetDuration", "c.aspectRatio", "p.name").orderBy("p.createTime", "desc").limit(100);
}
export async function readPilot(input: unknown, allowProjectCreativeFallback = false) {
  const parsed = scope.parse(input);
  return q.transaction(async trx => {
    const { project } = await checkedScope(trx, parsed);
    const creative = await trx("o_v04Creative").where(parsed).first() || (allowProjectCreativeFallback ? await trx("o_v04Creative").where({ projectId: parsed.projectId }).orderBy("scriptId").first() : null);
    if (!creative) throw new PilotError("PILOT_NOT_FOUND", "该项目没有 V0.4 工作空间", 404);
    const assets = await trx("o_v04Asset").where({ projectId: parsed.projectId }).orderBy("canonicalKey");
    const storyboards = await trx("o_storyboard").where(parsed).whereNull("retiredAt").orderBy("index", "asc").orderBy("id", "asc").select("id", "index", "prompt", "duration", "videoDesc", "productionSpec", "state", "filePath", "currentImageAttemptId", "activeImageAttemptId");
    const bindings = await trx("o_v04AssetBinding").where(parsed);
    const unitPlan = await readAssetPlanInTransaction(trx, parsed);
    const boundIds = [...new Set(unitPlan.items.map(item => item.assetId).filter((value): value is number => value !== null))];
    const boundAssets = boundIds.length ? await trx("o_assets").whereIn("id", boundIds).select("id", "imageId") : [];
    const imageIds = boundAssets.map(asset => asset.imageId).filter((value): value is number => value != null);
    const images = imageIds.length ? await trx("o_image").whereIn("id", imageIds).select("id", "state", "filePath") : [];
    const assetById = new Map(boundAssets.map(asset => [asset.id, asset]));
    const imageById = new Map(images.map(image => [image.id, image]));
    const assetPlan = unitPlan.items.map(item => {
      const asset = item.assetId === null ? null : assetById.get(item.assetId);
      const image = asset?.imageId == null ? null : imageById.get(asset.imageId);
      const ready = item.bindingValid && image?.state === "已完成" && Boolean(image.filePath);
      return { ...item, ready, status: item.assetId === null ? "UNBOUND" : !item.bindingValid ? "SOURCE_INVALID" : ready ? "READY" : "INCOMPLETE" };
    });
    const decisions = await trx("o_v04Decision").where({ projectId: parsed.projectId }).orderBy("createdAt", "desc").limit(100);
    const agentReferences = await trx("o_v04AgentReference as ref").join("o_v04AgentAttachment as image", "image.id", "ref.attachmentId")
      .where("ref.projectId", parsed.projectId).select("ref.id", "ref.scriptId", "ref.targetType", "ref.targetKey", "ref.assetId", "ref.attachmentId", "image.originalName", "image.mimeType", "image.sha256").orderBy("ref.createdAt", "desc").limit(200);
    return { project: { id: project.id, name: project.name }, creative, storyboards, assets: assets.map(a => ({ ...a, identityAnchors: JSON.parse(a.identityAnchors), mustPreserve: JSON.parse(a.mustPreserve), forbiddenChanges: JSON.parse(a.forbiddenChanges) })), bindings, assetPlan, agentReferences, decisions: decisions.map(d => ({ ...d, sourceMessageIds: JSON.parse(d.sourceMessageIds) })) };
  });
}
function creativePlan(current: any, data: z.infer<typeof creativeRequest>) {
  if (current.version !== data.expectedVersion) throw new PilotError("PILOT_PREVIEW_STALE", "创意内容已更新，请重新预览", 409);
  const proposed = { brief: data.brief, treatment: data.treatment, script: data.script, targetDuration: data.targetDuration };
  if (Object.keys(proposed).every(key => proposed[key as keyof typeof proposed] === current[key])) throw new PilotError("PILOT_NO_CHANGE", "没有可确认的更改");
  return { current: { brief: current.brief, treatment: current.treatment, script: current.script, targetDuration: current.targetDuration, version: current.version }, proposed, previewHash: hash({ projectId: data.projectId, scriptId: data.scriptId, current, proposed }) };
}
export async function previewCreative(input: unknown) {
  const data = creativeRequest.parse(input);
  return q.transaction(async trx => { await checkedScope(trx, data); const current = await trx("o_v04Creative").where({ projectId: data.projectId, scriptId: data.scriptId }).first(); if (!current) throw new PilotError("PILOT_NOT_FOUND", "工作空间不存在", 404); return creativePlan(current, data); });
}
export async function applyCreative(input: unknown) {
  const data = creativeRequest.extend({ previewHash: z.string().length(64) }).parse(input);
  return q.transaction(async trx => {
    await checkedScope(trx, data);
    const current = await trx("o_v04Creative").where({ projectId: data.projectId, scriptId: data.scriptId }).first();
    if (!current) throw new PilotError("PILOT_NOT_FOUND", "工作空间不存在", 404);
    const plan = creativePlan(current, data);
    if (plan.previewHash !== data.previewHash) throw new PilotError("PILOT_PREVIEW_STALE", "预览已过期", 409);
    await trx("o_v04Creative").where({ projectId: data.projectId, scriptId: data.scriptId }).update({ ...plan.proposed, version: current.version + 1, updatedAt: Date.now() });
    await trx("o_script").where({ id: data.scriptId, projectId: data.projectId }).update({ content: data.script });
    return { version: current.version + 1 };
  });
}

async function planAssets(trx: Knex.Transaction, data: z.infer<typeof assetRequest>) {
  await checkedScope(trx, data);
  if (data.sourceCreativeVersion !== undefined) {
    const creative = await trx("o_v04Creative").where({ projectId: data.projectId, scriptId: data.scriptId }).first();
    if (creative?.version !== data.sourceCreativeVersion) throw new PilotError("PILOT_SOURCE_STALE", "创意内容已更新，请重新生成素材提案", 409);
  }
  const rows = await trx("o_v04Asset").where({ projectId: data.projectId }).orderBy("canonicalKey");
  const byKey = new Map(rows.map(r => [r.canonicalKey as string, r]));
  const refs = new Set<string>();
  const suggestions: any[] = [];
  const changes = data.changes.map(change => {
    if (change.operation === "ADD") {
      if (refs.has(change.clientRef)) throw new PilotError("PILOT_DUPLICATE_REF", "候选引用重复");
      refs.add(change.clientRef);
      for (const key of [change.asset.ownerKey, change.asset.variantOf]) if (key && (!byKey.has(key) || byKey.get(key)?.status !== "ACTIVE")) throw new PilotError("PILOT_RELATION_INVALID", "归属或变体来源必须是当前项目现有的有效身份");
      // Names are suggestions only: never silently merge identities by name.
      suggestions.push({ clientRef: change.clientRef, possibleMatches: rows.filter(r => r.status === "ACTIVE" && r.name.toLowerCase() === change.asset.name.toLowerCase()).map(r => r.canonicalKey) });
      return change;
    }
    const row = byKey.get(change.canonicalKey);
    if (!row || row.status !== "ACTIVE") throw new PilotError("PILOT_ASSET_NOT_FOUND", "资产身份不存在或已退休", 404);
    if (row.revision !== change.expectedRevision) throw new PilotError("PILOT_PREVIEW_STALE", "资产身份已变化", 409);
    if (change.operation === "EDIT") for (const key of [change.patch.ownerKey, change.patch.variantOf]) if (key && (key === change.canonicalKey || !byKey.has(key) || byKey.get(key)?.status !== "ACTIVE")) throw new PilotError("PILOT_RELATION_INVALID", "归属或变体来源无效");
    if (refs.has(change.canonicalKey)) throw new PilotError("PILOT_CONFLICT", "同一资产存在冲突操作");
    refs.add(change.canonicalKey);
    return change;
  });
  return { changes, suggestions, previewHash: hash({ projectId: data.projectId, scriptId: data.scriptId, rows, changes }) };
}
export async function previewAssets(input: unknown) {
  const data = assetRequest.parse(input);
  return q.transaction(trx => planAssets(trx, data));
}
export async function applyAssets(input: unknown) {
  const data = assetRequest.extend({ previewHash: z.string().length(64) }).parse(input);
  return q.transaction(async trx => {
    const plan = await planAssets(trx, data);
    if (plan.previewHash !== data.previewHash) throw new PilotError("PILOT_PREVIEW_STALE", "素材预览已过期", 409);
    const applied: { clientRef?: string; canonicalKey: string; assetId?: number }[] = [];
    for (const change of plan.changes) {
      if (change.operation === "ADD") {
        const prefix = change.asset.category;
        const seq = await trx("o_v04AssetSequence").where({ projectId: data.projectId, prefix }).first();
        const number = seq?.nextNumber ?? 1;
        const canonicalKey = `${prefix}-${String(number).padStart(3, "0")}`;
        if (seq) await trx("o_v04AssetSequence").where({ projectId: data.projectId, prefix }).update({ nextNumber: number + 1 });
        else await trx("o_v04AssetSequence").insert({ projectId: data.projectId, prefix, nextNumber: 2 });
        const a = change.asset;
        await trx("o_v04Asset").insert({ projectId: data.projectId, canonicalKey, category: a.category, name: a.name, description: a.description, identityAnchors: JSON.stringify(a.identityAnchors), mustPreserve: JSON.stringify(a.mustPreserve), forbiddenChanges: JSON.stringify(a.forbiddenChanges), ownerKey: a.ownerKey, variantOf: a.variantOf, sourcePolicy: a.sourcePolicy, prompt: a.prompt, status: "ACTIVE", revision: 1, createdAt: Date.now(), updatedAt: Date.now() });
        const [assetId] = await trx("o_assets").insert({ projectId: data.projectId, scriptId: data.scriptId, name: a.name, describe: a.description, prompt: a.prompt, type: ({ CHAR: "role", LOC: "scene" } as Record<string, string>)[a.category] ?? "tool", startTime: Date.now() });
        await trx("o_scriptAssets").insert({ scriptId: data.scriptId, assetId });
        await trx("o_v04AssetBinding").insert({ projectId: data.projectId, scriptId: data.scriptId, canonicalKey, assetId });
        // The unit's Asset Plan is still authoritative for Gate readiness.
        const last = await trx(ASSET_PLAN_TABLE).where({ projectId: data.projectId, scriptId: data.scriptId }).max({ value: "position" }).first();
        const position = last?.value == null ? 0 : Number(last.value) + 1;
        await trx(ASSET_PLAN_TABLE).insert({ projectId: data.projectId, scriptId: data.scriptId, assetKey: canonicalKey, name: a.name, category: a.category, required: 1, sourcePolicy: a.sourcePolicy, assetId: a.sourcePolicy === "AI_ALLOWED" ? assetId : null, position });
        applied.push({ clientRef: change.clientRef, canonicalKey, assetId });
      } else if (change.operation === "EDIT") {
        const patch: Record<string, unknown> = { ...change.patch, revision: change.expectedRevision + 1, updatedAt: Date.now() };
        for (const key of ["identityAnchors", "mustPreserve", "forbiddenChanges"]) if (key in patch) patch[key] = JSON.stringify(patch[key]);
        await trx("o_v04Asset").where({ projectId: data.projectId, canonicalKey: change.canonicalKey }).update(patch);
        if (change.patch.name !== undefined || change.patch.category !== undefined || change.patch.sourcePolicy !== undefined) {
          const planPatch = { ...(change.patch.name !== undefined ? { name: change.patch.name } : {}), ...(change.patch.category !== undefined ? { category: change.patch.category } : {}), ...(change.patch.sourcePolicy !== undefined ? { sourcePolicy: change.patch.sourcePolicy, assetId: null } : {}) };
          await trx(ASSET_PLAN_TABLE).where({ projectId: data.projectId, scriptId: data.scriptId, assetKey: change.canonicalKey }).update(planPatch);
        }
        if (change.patch.name !== undefined || change.patch.description !== undefined || change.patch.prompt !== undefined || change.patch.category !== undefined) {
          const binding = await trx("o_v04AssetBinding").where({ projectId: data.projectId, scriptId: data.scriptId, canonicalKey: change.canonicalKey }).first();
          if (binding) await trx("o_assets").where({ id: binding.assetId, projectId: data.projectId }).update({ ...(change.patch.name !== undefined ? { name: change.patch.name } : {}), ...(change.patch.description !== undefined ? { describe: change.patch.description } : {}), ...(change.patch.prompt !== undefined ? { prompt: change.patch.prompt } : {}), ...(change.patch.category !== undefined ? { type: ({ CHAR: "role", LOC: "scene" } as Record<string, string>)[change.patch.category] ?? "tool" } : {}) });
        }
        applied.push({ canonicalKey: change.canonicalKey });
      } else {
        await trx("o_v04Asset").where({ projectId: data.projectId, canonicalKey: change.canonicalKey }).update({ status: "RETIRED", revision: change.expectedRevision + 1, updatedAt: Date.now() });
        await trx(ASSET_PLAN_TABLE).where({ projectId: data.projectId, scriptId: data.scriptId, assetKey: change.canonicalKey }).update({ assetId: null });
        // Preserve historical assetId, bindings and production outputs.
        applied.push({ canonicalKey: change.canonicalKey });
      }
    }
    return { applied };
  });
}

export async function resolveAssets(input: unknown) {
  const data = scope.extend({ canonicalKeys: z.array(z.string().min(1).max(128)).max(100) }).parse(input);
  return q.transaction(async trx => {
    await checkedScope(trx, data);
    const result = [];
    for (const canonicalKey of data.canonicalKeys) {
      const [identity, plan] = await Promise.all([
        trx("o_v04Asset").where({ projectId: data.projectId, canonicalKey, status: "ACTIVE" }).first(),
        trx(ASSET_PLAN_TABLE).where({ projectId: data.projectId, scriptId: data.scriptId, assetKey: canonicalKey }).first(),
      ]);
      if (!identity || !plan || !plan.assetId) throw new PilotError("PILOT_ASSET_UNBOUND", `${canonicalKey} 尚未绑定当前制作单元`, 409);
      // The production-unit Asset Plan owns the concrete binding. Its assetId
      // may change when a user uploads and binds a genuine asset in Preparation.
      await assertAssetPlanBinding(trx, data, { assetId: plan.assetId, sourcePolicy: plan.sourcePolicy });
      const asset = await trx("o_assets").where({ id: plan.assetId, projectId: data.projectId }).first();
      const image = asset?.imageId ? await trx("o_image").where({ id: asset.imageId, assetsId: asset.id }).first() : null;
      result.push({ canonicalKey, assetId: plan.assetId, name: identity.name, category: identity.category, sourcePolicy: plan.sourcePolicy, referenceFilePath: image?.state === "已完成" ? image.filePath : null });
    }
    return { projectId: data.projectId, scriptId: data.scriptId, resolved: result, associateAssetsIds: result.map(x => x.assetId) };
  });
}

export async function proposeDecision(input: unknown) {
  const data = scope.extend({ category: z.string().min(1).max(80), subjectType: z.string().max(80).nullable(), subjectKey: z.string().max(128).nullable(), content: z.string().trim().min(1).max(4000), sourceMessageIds: z.array(z.string().uuid()).max(50).default([]) }).parse(input);
  return q.transaction(async trx => { await checkedScope(trx, data); const decisionId = randomUUID(); await trx("o_v04Decision").insert({ id: decisionId, ...data, sourceMessageIds: JSON.stringify(data.sourceMessageIds), status: "PROPOSED", supersedesDecisionId: null, createdAt: Date.now(), acceptedAt: null }); return { decisionId, status: "PROPOSED" }; });
}
export async function decide(input: unknown) {
  const data = scope.extend({ decisionId: z.string().uuid(), status: z.enum(["ACCEPTED", "REJECTED"]) }).parse(input);
  return q.transaction(async trx => { await checkedScope(trx, data); const row = await trx("o_v04Decision").where({ id: data.decisionId, projectId: data.projectId, scriptId: data.scriptId }).first(); if (!row || row.status !== "PROPOSED") throw new PilotError("PILOT_DECISION_INVALID", "决定不存在或已处理", 409); await trx("o_v04Decision").where({ id: data.decisionId }).update({ status: data.status, acceptedAt: Date.now() }); return { decisionId: data.decisionId, status: data.status }; });
}

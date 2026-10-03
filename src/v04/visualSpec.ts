import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { db } from "@/utils/db";
import { requireModel } from "@/services/modelPreset";
import { PilotError } from "./service";
import { reviewPlanFor, type AssetKind } from "./assetWorkflow";
import { compileVisualSemanticWithDiagnostics, visualDetailTemplate, visualSpecSchema, type VisualSpec } from "./visualSpecContract";
import { VISUAL_NORMALIZER_VERSION, VisualSemanticRootError } from "./visualSemanticNormalizer";
import { compilePromptIR, compilerVersionForIntent, generationIntents, intentFromReviewPlan, renderGenericPrompt } from "./promptCompiler";

const q = db as Knex;
const id = z.number().int().positive();
const key = z.string().min(1).max(128);
const scope = z.object({ projectId: id, scriptId: id }).strict();
const target = scope.extend({ canonicalKey: key });
const proposalRequest = scope.extend({ canonicalKeys: z.array(key).min(1).max(6) });
const previewRequest = target.extend({ sourceAssetRevision: id, spec: visualSpecSchema });
const applyRequest = previewRequest.extend({ previewHash: z.string().length(64) });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function current(trx: Knex.Transaction, data: z.infer<typeof target>, includeObservations = false) {
  const [project, unit, asset] = await Promise.all([
    trx("o_project").where({ id: data.projectId }).first(),
    trx("o_script").where({ id: data.scriptId, projectId: data.projectId }).first(),
    trx("o_v04Asset").where({ projectId: data.projectId, canonicalKey: data.canonicalKey, status: "ACTIVE" }).first(),
  ]);
  if (!project || !unit || !asset) throw new PilotError("PILOT_VISUAL_SCOPE_INVALID", "项目、制作单元或有效资产不存在", 404);
  const refs = await trx("o_v04AgentReference as ref")
    .join("o_v04AgentAttachment as attachment", "attachment.id", "ref.attachmentId")
    .where({ "ref.projectId": data.projectId, "ref.targetKey": data.canonicalKey,
      "ref.targetType": "ASSET_BIBLE", "attachment.projectId": data.projectId })
    .orderBy("ref.createdAt", "asc").limit(31).select("ref.attachmentId", "attachment.originalName");
  if (refs.length > 30) throw new PilotError("PILOT_VISUAL_REFERENCE_LIMIT", "已确认参考过多，请先整理引用", 422);
  const cached = includeObservations && refs.length ? await trx("o_v04VisionAnalysis").where({ analysisVersion: 1 }).whereIn("attachmentId", refs.map(ref => ref.attachmentId))
    .orderBy("createdAt", "desc").select("attachmentId", "observationJson") : [];
  const observed = new Map<string, { attachmentId: string; summary: string; uncertainty: string[] }>();
  for (const row of cached) {
    if (observed.has(row.attachmentId)) continue;
    try {
      const parsed = z.object({ summary: z.string(), uncertainty: z.array(z.string()).optional() }).passthrough().parse(JSON.parse(row.observationJson));
      observed.set(row.attachmentId, { attachmentId: row.attachmentId, summary: parsed.summary.slice(0, 600), uncertainty: (parsed.uncertainty ?? []).slice(0, 30).map(x => x.slice(0, 600)) });
    } catch { /* Invalid cache is never promoted into project truth. */ }
  }
  const previous = await trx("o_v04AssetVisualSpec").where({ projectId: data.projectId, canonicalKey: data.canonicalKey, status: "CONFIRMED" }).orderBy("revision", "desc").first();
  return { asset, refs, previous, observedReferenceNotes: [...observed.values()] };
}
function array(raw: string): string[] { return JSON.parse(raw); }
function identity(row: any, effectiveKind: AssetKind) {
  return { ...row, assetKind: effectiveKind, identityAnchors: array(row.identityAnchors),
    mustPreserve: array(row.mustPreserve), forbiddenChanges: array(row.forbiddenChanges) };
}
function kindOf(asset: any): AssetKind {
  if (asset.category === "BRAND") return "BRAND_MARK";
  if (asset.category === "UI") return "UI_REFERENCE";
  return asset.assetKind;
}
function referenceOnly(asset: any) { return asset.sourcePolicy === "REAL_REQUIRED" || ["BRAND", "UI"].includes(asset.category); }
function validateSpec(asset: any, refs: { attachmentId: string }[], spec: VisualSpec) {
  if (spec.assetKind !== kindOf(asset)) throw new PilotError("PILOT_VISUAL_KIND_MISMATCH", "视觉规格类型与当前资产身份不一致", 422);
  if (["BRAND_MARK", "UI_REFERENCE"].includes(spec.assetKind)) {
    if (!referenceOnly(asset) || !refs.length) throw new PilotError("PILOT_VISUAL_REAL_REFERENCE_REQUIRED", "品牌或界面需要已确认的真实参考", 422);
    const detail = spec.details as { referenceDerived: true; aiRedrawAllowed: false; referenceAttachmentIds: string[] };
    if (detail.referenceAttachmentIds.length !== refs.length || detail.referenceAttachmentIds.some(id => !refs.some(ref => ref.attachmentId === id)))
      throw new PilotError("PILOT_VISUAL_REAL_REFERENCE_REQUIRED", "视觉规格必须使用当前已确认的真实参考", 422);
  }
  if (spec.assetKind === "MATERIAL_FX" && (spec.details as { states: { key: string }[] }).states.map(s => s.key).join(",") !== "MIST,PARTICLE,SILHOUETTE,SOLID")
    throw new PilotError("PILOT_VISUAL_STATES_INVALID", "材质状态必须依次为 Mist、Particle、Silhouette、Solid", 422);
}
function completenessIssues(spec: VisualSpec): string[] {
  if (spec.assetKind === "BRAND_MARK" || spec.assetKind === "UI_REFERENCE") return [];
  const issues: string[] = [];
  const required = (path: string, value: unknown) => { if (typeof value !== "string" || !value.trim()) issues.push(path); };
  required("visualIdentitySummary", spec.visualIdentitySummary);
  required("silhouette", spec.silhouette);
  if (!spec.primaryPalette.length) issues.push("primaryPalette");
  switch (spec.assetKind) {
    case "HUMAN_CHARACTER":
      for (const field of ["ageRange", "footwear"] as const) required(`details.${field}`, spec.details[field]);
      required("details.hair.color", spec.details.hair.color);
      required("details.hair.silhouette", spec.details.hair.silhouette);
      required("details.body.build", spec.details.body.build);
      required("details.wardrobe.upper", spec.details.wardrobe.upper);
      break;
    case "CREATURE":
      required("details.speciesOrForm", spec.details.speciesOrForm);
      required("details.bodyStructure", spec.details.bodyStructure);
      required("details.surface", spec.details.surface);
      break;
    case "VEHICLE":
      required("details.vehicleType", spec.details.vehicleType);
      required("details.mainStructure", spec.details.mainStructure);
      break;
    case "ENVIRONMENT":
      for (const field of ["spaceType", "foreground", "midground", "background", "lighting", "atmosphere"] as const)
        required(`details.${field}`, spec.details[field]);
      break;
    case "MATERIAL_FX":
      for (const field of ["baseColor", "emissionColor", "particleLanguage", "edgeLanguage"] as const)
        required(`details.${field}`, spec.details[field]);
      spec.details.states.forEach((state, index) => required(`details.states.${index}.appearance`, state.appearance));
      break;
    case "CELESTIAL": required("details.form", spec.details.form); required("details.surfaceOrGlow", spec.details.surfaceOrGlow); break;
    case "PROP": case "OTHER": required("details.structure", spec.details.structure); break;
  }
  return issues;
}

// Proposal generation is read-only. A revision is captured before any model
// call and rechecked by Preview/Apply; it never becomes truth on its own.
export async function proposeVisualSpecs(input: unknown) {
  const data = proposalRequest.parse(input);
  const keys = [...new Set(data.canonicalKeys)];
  const captured = await q.transaction(async trx => {
    const unit = await trx("o_script").where({ id: data.scriptId, projectId: data.projectId }).first();
    if (!unit) throw new PilotError("PILOT_VISUAL_SCOPE_INVALID", "制作单元不存在", 404);
    const results: { canonicalKey: string; captured?: Awaited<ReturnType<typeof current>>; error?: PilotError }[] = [];
    for (const canonicalKey of keys) {
      try { results.push({ canonicalKey, captured: await current(trx, { ...data, canonicalKey }, true) }); }
      catch (error) { if (!(error instanceof PilotError)) throw error; results.push({ canonicalKey, error }); }
    }
    return results;
  });
  const candidates = [], failures: { canonicalKey: string; name: string; code: string; message: string }[] = [];
  for (const entry of captured) {
    const asset = entry.captured ? identity(entry.captured.asset, kindOf(entry.captured.asset)) : null;
    try {
      if (entry.error) throw entry.error;
      if (!entry.captured || !asset) throw new PilotError("PILOT_VISUAL_SCOPE_INVALID", "有效资产不存在", 404);
      if (["BRAND_MARK", "UI_REFERENCE"].includes(asset.assetKind) && !entry.captured.refs.length)
        throw new PilotError("PILOT_VISUAL_REAL_REFERENCE_REQUIRED", "品牌或界面需要已确认的真实参考", 422);
      let semantic: unknown = {};
      if (!referenceOnly(entry.captured.asset)) {
        let model: Awaited<ReturnType<typeof requireModel>>;
        try { model = await requireModel(data.projectId, "text"); }
        catch { throw new PilotError("PILOT_VISUAL_MODEL_FAILED", "文本模型不可用，请检查配置", 502); }
        try {
          const system = `你为一个已确认的项目资产提出视觉规格草案，只输出一个 JSON 对象。不要写数据库字段、资产 ID 或图片生成指令。请描述稳定外观：visualIdentitySummary, silhouette, scale, proportion, primaryPalette, secondaryPalette, materials, surfaceLanguage, distinctiveFeatures, continuityNotes, identityAnchors, mustPreserve, forbiddenChanges, details（当前类型的外观细节）, embeddedElements。字段可省略，数组可使用单项文字，服务器会规范化结构和枚举；不要编造缺失的创意细节。已确认身份和真实素材约束不可被推翻；挂件只作为 embeddedElements，不自动创建资产。不要重画真实 Logo/UI。`;
          const result = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({ system,
            messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ asset: {
              canonicalKey: entry.canonicalKey, name: asset.name, assetKind: asset.assetKind, description: asset.description,
              identityAnchors: asset.identityAnchors, mustPreserve: asset.mustPreserve, forbiddenChanges: asset.forbiddenChanges,
              sharedVisualSystemKey: asset.sharedVisualSystemKey, relatedKeys: array(asset.relatedKeys),
              optionalDetailHints: visualDetailTemplate(asset.assetKind),
            } }) }] }], output: Output.json() });
          semantic = result.output;
        } catch (error) {
          console.error("[V04 VisualSpec][ProposalFailure]", { projectId: data.projectId, canonicalKey: entry.canonicalKey,
            assetKind: asset.assetKind, normalizerVersion: VISUAL_NORMALIZER_VERSION, code: "MODEL_FAILED",
            errorName: error instanceof Error ? error.name : "Error" });
          throw new PilotError("PILOT_VISUAL_MODEL_FAILED", "视觉规格模型调用失败，请稍后重试", 502);
        }
      }
      let compiled: ReturnType<typeof compileVisualSemanticWithDiagnostics>;
      try {
        compiled = compileVisualSemanticWithDiagnostics(asset, semantic, entry.captured.refs.map(ref => ref.attachmentId), entry.captured.observedReferenceNotes);
        validateSpec(entry.captured.asset, entry.captured.refs, compiled.spec);
      } catch (error) {
        if (error instanceof PilotError) throw error;
        const code = error instanceof VisualSemanticRootError ? "SEMANTIC_ROOT_INVALID" : "CANONICAL_COMPILER_FAILED";
        const paths = error instanceof z.ZodError ? error.issues.map(issue => issue.path.join(".")).slice(0, 20)
          : error instanceof VisualSemanticRootError ? [error.path] : [];
        console.error("[V04 VisualSpec][NormalizationFailure]", { projectId: data.projectId, canonicalKey: entry.canonicalKey,
          assetKind: asset.assetKind, normalizerVersion: VISUAL_NORMALIZER_VERSION, code, paths });
        throw error instanceof VisualSemanticRootError
          ? new PilotError("PILOT_VISUAL_SEMANTIC_ROOT_INVALID", "视觉语义根结构无效，请单项重试", 422)
          : new PilotError("PILOT_VISUAL_COMPILER_FAILED", "视觉规格编译失败，请稍后重试", 500);
      }
      if (compiled.normalizationWarnings.length) console.info("[V04 VisualSpec][NormalizedWithWarnings]", {
        canonicalKey: entry.canonicalKey, assetKind: asset.assetKind, normalizerVersion: VISUAL_NORMALIZER_VERSION,
        code: "SEMANTIC_NORMALIZED_WITH_WARNINGS", paths: compiled.normalizationWarnings.map(warning => warning.path).slice(0, 30) });
      candidates.push({ canonicalKey: entry.canonicalKey, sourceAssetRevision: entry.captured.asset.revision,
        spec: compiled.spec, previousRevision: entry.captured.previous?.revision ?? null,
        normalizationWarnings: compiled.normalizationWarnings, qualityWarnings: compiled.qualityWarnings, applied: false });
    } catch (error) {
      const safe = error instanceof PilotError ? error : new PilotError("PILOT_VISUAL_COMPILER_FAILED", "视觉规格编译失败，请稍后重试", 500);
      if (keys.length === 1) throw safe;
      failures.push({ canonicalKey: entry.canonicalKey, name: asset?.name ?? entry.canonicalKey, code: safe.code, message: safe.message });
    }
  }
  return { candidates, failures, applied: false };
}

async function plan(trx: Knex.Transaction, data: z.infer<typeof previewRequest>) {
  const { asset, refs, previous } = await current(trx, data);
  if (asset.revision !== data.sourceAssetRevision) throw new PilotError("PILOT_VISUAL_SOURCE_STALE", "资产身份已更新，请重新生成视觉规格", 409);
  validateSpec(asset, refs, data.spec);
  if (previous?.sourceAssetRevision === asset.revision && previous.specJson === JSON.stringify(data.spec))
    throw new PilotError("PILOT_VISUAL_NO_CHANGE", "视觉规格未发生变化", 409);
  const source = previous ? { revision: previous.revision, specJson: previous.specJson, sourceAssetRevision: previous.sourceAssetRevision } : null;
  return { canonicalKey: data.canonicalKey, sourceAssetRevision: asset.revision, current: source, currentSpec: previous ? JSON.parse(previous.specJson) : null,
    proposed: data.spec, issues: completenessIssues(data.spec), nextRevision: (previous?.revision ?? 0) + 1,
    previewHash: digest({ projectId: data.projectId, canonicalKey: data.canonicalKey, asset,
      refs, source, proposed: data.spec }) };
}
export async function previewVisualSpec(input: unknown) {
  const data = previewRequest.parse(input);
  return q.transaction(trx => plan(trx, data));
}

async function savePromptBuild(trx: Knex.Transaction, projectId: number, canonicalKey: string, asset: any, spec: VisualSpec, specRevision: number, refs: { attachmentId: string; originalName: string }[], previewKind: string) {
  const generationIntent = intentFromReviewPlan(asset, { previewKind });
  if (!generationIntent) return null;
  const ir = compilePromptIR(asset, spec, generationIntent, refs.map(ref => ({ attachmentId: ref.attachmentId, name: ref.originalName })));
  const rendered = renderGenericPrompt(ir);
  const row = { projectId, canonicalKey, visualSpecRevision: specRevision, compilerVersion: compilerVersionForIntent(generationIntent),
    generationIntent, targetProfile: "generic.text.v1", promptIrJson: JSON.stringify(ir), renderedPromptJson: JSON.stringify(rendered),
    status: "READY", createdAt: Date.now(), updatedAt: Date.now() };
  await trx("o_v04AssetPromptBuild").insert(row).onConflict(["projectId", "canonicalKey", "visualSpecRevision", "compilerVersion", "generationIntent", "targetProfile"]).merge(row);
  return { ...row, promptIr: ir, renderedPrompt: rendered };
}

export async function applyVisualSpec(input: unknown) {
  const data = applyRequest.parse(input);
  return q.transaction(async trx => {
    const planned = await plan(trx, data);
    if (planned.previewHash !== data.previewHash) throw new PilotError("PILOT_VISUAL_PREVIEW_STALE", "视觉规格预览已过期", 409);
    if (planned.issues.length) throw new PilotError("PILOT_VISUAL_INCOMPLETE", `请补齐视觉规格：${planned.issues.join("、")}`, 422);
    const { asset, refs, previous } = await current(trx, data);
    const projection = { identityAnchors: JSON.stringify(data.spec.identityAnchors),
      mustPreserve: JSON.stringify(data.spec.mustPreserve), forbiddenChanges: JSON.stringify(data.spec.forbiddenChanges) };
    const changed = Object.entries(projection).some(([field, value]) => asset[field] !== value);
    const sourceAssetRevision = asset.revision + (changed ? 1 : 0);
    if (changed) await trx("o_v04Asset").where({ projectId: data.projectId, canonicalKey: data.canonicalKey, revision: asset.revision }).update({ ...projection, revision: sourceAssetRevision, updatedAt: Date.now() });
    if (previous) await trx("o_v04AssetVisualSpec").where({ projectId: data.projectId, canonicalKey: data.canonicalKey, revision: previous.revision }).update({ status: "SUPERSEDED", updatedAt: Date.now() });
    await trx("o_v04AssetPromptBuild").where({ projectId: data.projectId, canonicalKey: data.canonicalKey, status: "READY" }).update({ status: "STALE", updatedAt: Date.now() });
    const revision = planned.nextRevision;
    await trx("o_v04AssetVisualSpec").insert({ projectId: data.projectId, canonicalKey: data.canonicalKey,
      revision, status: "CONFIRMED", sourceAssetRevision, specJson: JSON.stringify(data.spec), createdAt: Date.now(), updatedAt: Date.now() });
    const review = await trx("o_v04AssetReviewPlan").where({ projectId: data.projectId, scriptId: data.scriptId, canonicalKey: data.canonicalKey }).first();
    const planKind = review?.previewKind ?? reviewPlanFor(asset).previewKind;
    const promptBuild = await savePromptBuild(trx, data.projectId, data.canonicalKey, asset, data.spec, revision, refs, planKind);
    return { canonicalKey: data.canonicalKey, revision, sourceAssetRevision, status: "CONFIRMED", promptStatus: promptBuild ? "READY" : "REFERENCE_ONLY" };
  });
}

export async function rebuildVisualPrompt(input: unknown) {
  const data = target.extend({ generationIntent: z.enum(generationIntents).optional() }).parse(input);
  return q.transaction(async trx => {
    const { asset, refs, previous } = await current(trx, data);
    if (!previous || previous.sourceAssetRevision !== asset.revision) throw new PilotError("PILOT_VISUAL_SOURCE_STALE", "请先确认当前身份的视觉规格", 409);
    const review = await trx("o_v04AssetReviewPlan").where({ projectId: data.projectId, scriptId: data.scriptId, canonicalKey: data.canonicalKey }).first();
    const defaultIntent = intentFromReviewPlan(asset, { previewKind: review?.previewKind ?? reviewPlanFor(asset).previewKind });
    if (!defaultIntent || referenceOnly(asset)) throw new PilotError("PILOT_VISUAL_REFERENCE_ONLY", "真实素材不生成 AI Prompt", 409);
    const intent = data.generationIntent ?? defaultIntent;
    if (intent !== defaultIntent) throw new PilotError("PILOT_VISUAL_INTENT_INVALID", "生成意图与现有 Review Plan 不一致", 422);
    const spec = visualSpecSchema.parse(JSON.parse(previous.specJson));
    const build = await savePromptBuild(trx, data.projectId, data.canonicalKey, asset, spec, previous.revision, refs, review?.previewKind ?? reviewPlanFor(asset).previewKind);
    return { canonicalKey: data.canonicalKey, visualSpecRevision: previous.revision, promptBuild: build };
  });
}

const bindingRequest = target.extend({ libraryAssetId: z.string().min(1).max(128).nullable(), libraryVersion: id.nullable(),
  visualProfileId: z.string().min(1).max(128).nullable(), visualProfileVersion: id.nullable(),
  reuseMode: z.enum(["EXACT_REUSE", "VARIANT", "FORK"]).nullable() });
export async function setLibraryBinding(input: unknown) {
  const data = bindingRequest.parse(input);
  if (Boolean(data.libraryAssetId) !== Boolean(data.libraryVersion) || Boolean(data.visualProfileId) !== Boolean(data.visualProfileVersion)
    || Boolean(data.libraryAssetId) !== Boolean(data.reuseMode)) throw new PilotError("PILOT_LIBRARY_PIN_INVALID", "资产库引用必须精确固定版本与复用方式", 422);
  return q.transaction(async trx => {
    await current(trx, data);
    const row = { projectId: data.projectId, canonicalKey: data.canonicalKey, libraryAssetId: data.libraryAssetId,
      libraryVersion: data.libraryVersion, visualProfileId: data.visualProfileId, visualProfileVersion: data.visualProfileVersion,
      reuseMode: data.reuseMode, createdAt: Date.now(), updatedAt: Date.now() };
    await trx("o_v04AssetLibraryBinding").insert(row).onConflict(["projectId", "canonicalKey"]).merge({
      libraryAssetId: row.libraryAssetId, libraryVersion: row.libraryVersion, visualProfileId: row.visualProfileId,
      visualProfileVersion: row.visualProfileVersion, reuseMode: row.reuseMode, updatedAt: row.updatedAt });
    return { ...row, projectIdentityUnchanged: true, globalIdentityCreated: false };
  });
}

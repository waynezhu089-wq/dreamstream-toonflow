import { produceAssetImageEdit } from "./assetImageEdit";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import { z } from "zod";
import { db } from "@/utils/db";
import getPath from "@/utils/getPath";
import { PilotError } from "./service";
import { compileStudioDraftPrompts } from "./visualSpec";
import { visualSpecSchema } from "./visualSpecContract";
import {submitTracedDraft,failSubmittedTrace} from './tracedDraftSubmit';
import {settleJobTraces} from './executionTrace';
import { awaitDraft, buildDraftWorkflow, downloadDraft, DraftComfyError, draftWorkflowVersion, inspectComfy,
  draftProfiles, LOCAL_DRAFT_V1, localComfyOrigin } from "./comfyDraftClient";
import { Z_IMAGE_SUBJECT_RENDERING_V1, Z_IMAGE_TURBO_SUBJECT_DRAFT_V1, zImageSubjectPrompt } from "./zImageSubjectProfile";

import { executionPurposes, characterReferenceExecutionPrompt, CHARACTER_REFERENCE_PACK_V1, type ExecutionPurpose } from "./characterReferencePack";

const q = db as Knex;
const scope = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive() }).strict();
const target = scope.extend({ canonicalKey: z.string().min(1).max(128) });
const draftInput = target.extend({ sourceAssetRevision: z.number().int().positive(), visualSpecDraft: visualSpecSchema,
  executionPurpose: z.enum(executionPurposes).optional(), force: z.boolean().default(false), width: z.number().int().min(512).max(1536).multipleOf(64).optional(),
  height: z.number().int().min(512).max(1536).multipleOf(64).optional(),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const configInput = z.object({ projectId: z.number().int().positive(), baseUrl: z.string().max(300),
  checkpoint: z.string().min(1).max(300), enabled: z.boolean(),
  profile: z.enum(draftProfiles).default(LOCAL_DRAFT_V1) }).strict();
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const safeFailure = (error: unknown) => error instanceof DraftComfyError ? error :
  new DraftComfyError("EXECUTION_FAILED", "草图执行失败，请稍后重试");

async function assertScope(trx: Knex.Transaction, data: { projectId: number; scriptId: number; canonicalKey?: string }) {
  const [project, script, asset] = await Promise.all([
    trx("o_project").where({ id: data.projectId }).first(),
    trx("o_script").where({ id: data.scriptId, projectId: data.projectId }).first(),
    data.canonicalKey ? trx("o_v04Asset").where({ projectId: data.projectId, canonicalKey: data.canonicalKey, status: "ACTIVE" }).first() : null,
  ]);
  if (!project || !script || (data.canonicalKey && !asset)) throw new PilotError("PILOT_SCOPE_INVALID", "项目、制作单元或有效素材不存在", 404);
  return asset;
}

export async function configureDraftExecutor(input: unknown) {
  const data = configInput.parse(input);
  const baseUrl = localComfyOrigin(data.baseUrl);
  const inspection = await inspectComfy(baseUrl, data.profile);
  if (data.enabled && (inspection.status !== "CONNECTED" || !inspection.checkpoints.includes(data.checkpoint)))
    throw new PilotError(inspection.status === "UNAVAILABLE" ? "COMFY_OFFLINE" : "MODEL_MISSING",
      "本地 ComfyUI 未连接，或所选 checkpoint 尚未安装", 409);
  return q.transaction(async trx => {
    if (!await trx("o_project").where({ id: data.projectId }).first()) throw new PilotError("PILOT_SCOPE_INVALID", "项目不存在", 404);
    const record = { projectId: data.projectId, provider: "COMFY_LOCAL", baseUrl,
      enabled: data.enabled, checkpoint: data.checkpoint, executorProfile: data.profile, updatedAt: Date.now() };
    await trx("o_v04StudioImageExecutorConfig").insert(record).onConflict("projectId").merge(record);
    return { ...record, connection: inspection.status };
  });
}

export async function testDraftExecutor(input: unknown) {
  const data = z.object({ projectId: z.number().int().positive(), baseUrl: z.string().max(300).optional(),
    profile: z.enum(draftProfiles).optional() }).strict().parse(input);
  const project = await q("o_project").where({ id: data.projectId }).first();
  if (!project) throw new PilotError("PILOT_SCOPE_INVALID", "项目不存在", 404);
  const current = await q("o_v04StudioImageExecutorConfig").where({ projectId: data.projectId }).first();
  return inspectComfy(data.baseUrl ?? current?.baseUrl ?? "http://127.0.0.1:8188",
    data.profile ?? current?.executorProfile ?? LOCAL_DRAFT_V1);
}

export async function readDraftExecutor(input: unknown) {
  const data = z.object({ projectId: z.number().int().positive() }).strict().parse(input);
  const current = await q("o_v04StudioImageExecutorConfig").where({ projectId: data.projectId }).first();
  return current ? { baseUrl: current.baseUrl, checkpoint: current.checkpoint,
    profile: current.executorProfile ?? LOCAL_DRAFT_V1, enabled: !!current.enabled } : null;
}

async function sourceSnapshot(data: z.infer<typeof draftInput>) {
  const compiled = await compileStudioDraftPrompts({ projectId: data.projectId, scriptId: data.scriptId,
    items: [{ canonicalKey: data.canonicalKey, sourceAssetRevision: data.sourceAssetRevision, spec: data.visualSpecDraft }] });
  if (compiled.failures.length || compiled.candidates.length !== 1)
    throw new PilotError(compiled.failures[0]?.code ?? "STALE_JOB", compiled.failures[0]?.message ?? "草案已过期", 409);
  const candidate = compiled.candidates[0];
  return { visualSpecDraft: data.visualSpecDraft, draftPromptIR: candidate.draftPromptIR,
    draftRenderedPrompt: candidate.draftRenderedPrompt, generationIntent: candidate.generationIntent };
}

function snapshotHash(source: any, config: any, zOptions?: { width: number; height: number; requestedSeed?: number; executionPurpose?: ExecutionPurpose | null }) {
  const profile = config.executorProfile ?? LOCAL_DRAFT_V1;
  const parts = [source.visualSpecDraft, source.draftPromptIR, source.generationIntent,
    source.draftPromptIR.referenceBindings, profile, draftWorkflowVersion(profile), config.checkpoint, config.baseUrl];
  // Preserve the Phase A hash bytes for existing LOCAL_DRAFT_V1 jobs.
  if (profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1) parts.push(zOptions?.width ?? 1024, zOptions?.height ?? 1024,
    zOptions?.requestedSeed ?? null, Z_IMAGE_SUBJECT_RENDERING_V1, zImageSubjectPrompt(source.draftPromptIR));
  if (zOptions?.executionPurpose) parts.push(CHARACTER_REFERENCE_PACK_V1, zOptions.executionPurpose,
    characterReferenceExecutionPrompt(source.draftPromptIR, zOptions.executionPurpose));
  return hash(parts);
}

export async function enqueueDraftImage(input: unknown) {
  const data = draftInput.parse(input);
  const source = await sourceSnapshot(data);
  const result = await q.transaction(async trx => {
    const asset = await assertScope(trx, data);
    if (Number(asset.revision) !== data.sourceAssetRevision || asset.sourcePolicy !== "AI_ALLOWED" ||
        ["BRAND", "UI"].includes(asset.category) || ["BRAND_MARK", "UI_REFERENCE"].includes(asset.assetKind))
      throw new PilotError("STALE_JOB", "素材已变化或必须使用真实参考，不能加入 AI 草图队列", 409);
    const config = await trx("o_v04StudioImageExecutorConfig").where({ projectId: data.projectId }).first();
    if (!config?.enabled) throw new PilotError("WORKFLOW_UNAVAILABLE", "请先启用本地 Comfy 草图执行器", 409);
    const profile = config.executorProfile ?? LOCAL_DRAFT_V1;
    if (profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 &&
        (source.generationIntent !== "CHARACTER_TURNAROUND" || source.visualSpecDraft.assetKind !== "HUMAN_CHARACTER"))
      throw new PilotError("WORKFLOW_UNAVAILABLE", "Z-Image 实验 profile 目前仅支持人物主视图", 409);
    if (data.executionPurpose && source.visualSpecDraft.assetKind !== "HUMAN_CHARACTER")
      throw new PilotError("WORKFLOW_UNAVAILABLE", "人物参考用途仅支持 HUMAN_CHARACTER", 409);
    const width = profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? data.width ?? 1024 : 512;
    const height = profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? data.height ?? 1024 : 512;
    const zOptions = { width, height, requestedSeed: data.seed, executionPurpose: data.executionPurpose };
    const draftHash = snapshotHash(source, config, zOptions);
    const existing = await trx("o_v04StudioAssetDraftJob").where({ projectId: data.projectId, scriptId: data.scriptId,
      canonicalKey: data.canonicalKey, sourceAssetRevision: data.sourceAssetRevision, draftHash })
      .orderBy("createdAt", "desc").first();
    if (existing && !data.force && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(existing.status))
      return { job: existing, reused: true };
    const now = Date.now();
    const job = { id: randomUUID(), projectId: data.projectId, scriptId: data.scriptId,
      canonicalKey: data.canonicalKey, sourceAssetRevision: data.sourceAssetRevision, draftHash,
      generationIntent: source.generationIntent, executionPurpose: data.executionPurpose ?? null, executorType: "COMFY_LOCAL", executorProfile: profile,
      workflowVersion: draftWorkflowVersion(profile), status: "QUEUED", comfyPromptId: null,
      inputSnapshotJson: JSON.stringify({ ...source, checkpoint: config.checkpoint, baseUrl: config.baseUrl,
        width, height, requestedSeed: data.seed ?? null, seed: data.seed ?? parseInt(draftHash.slice(0, 12), 16),
        executionPurpose: data.executionPurpose ?? (profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? "SUBJECT_MAIN_PREVIEW" : null),
        renderingLanguageVersion: profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? Z_IMAGE_SUBJECT_RENDERING_V1 : null,
        executionPrompt: data.executionPurpose ? characterReferenceExecutionPrompt(source.draftPromptIR, data.executionPurpose) : profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? zImageSubjectPrompt(source.draftPromptIR) : null }),
      outputsJson: "[]", errorCode: null, errorMessage: null,
      attemptCount: existing ? Number(existing.attemptCount) + 1 : 1,
      createdAt: now, startedAt: null, completedAt: null, updatedAt: now };
    await trx("o_v04StudioAssetDraftJob").insert(job);
    await trx("o_v04StudioAssetDraftJob").where({ projectId: data.projectId, scriptId: data.scriptId,
      canonicalKey: data.canonicalKey }).where({ executionPurpose: data.executionPurpose ?? null }).whereNot({ id: job.id }).whereIn("status", ["QUEUED", "RUNNING", "SUCCEEDED"])
      .update({ status: "STALE", updatedAt: now });
    return { job, reused: false };
  });
  wakeDraftWorker();
  return { job: publicJob(result.job), reused: result.reused };
}

function publicJob(job: any) {
  return { id: job.id, projectId: job.projectId, scriptId: job.scriptId, canonicalKey: job.canonicalKey,
    sourceAssetRevision: job.sourceAssetRevision, draftHash: job.draftHash, generationIntent: job.generationIntent,
    executorProfile: job.executorProfile, executionPurpose: job.executionPurpose ?? (job.executorProfile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? "SUBJECT_MAIN_PREVIEW" : null),
    workflowVersion: job.workflowVersion, status: job.status,
    attemptCount: job.attemptCount, outputs: JSON.parse(job.outputsJson), errorCode: job.errorCode,
    errorMessage: job.errorMessage, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

export async function listDraftJobs(input: unknown) {
  const data = scope.parse(input);
  return q.transaction(async trx => {
    await assertScope(trx, data);
    // Image-edit candidates have their own review surface. They must not become
    // Reference Pack display jobs before explicit adoption.
    const rows = await trx("o_v04StudioAssetDraftJob").where(data).whereNot("generationIntent", "ASSET_IMAGE_EDIT").orderBy("createdAt", "desc").limit(300);
    return rows.map(publicJob);
  });
}

export async function getDraftArtifact(projectId: number, artifactId: string) {
  z.string().uuid().parse(artifactId);
  const artifact = await q("o_v04StudioDraftArtifact").where({ projectId, artifactId }).first();
  if (!artifact) throw new PilotError("ARTIFACT_MISSING", "草图不存在或不属于当前项目", 404);
  return { bytes: await fs.readFile(getPath(["v04-draft-artifacts", String(projectId), `${artifactId}.${artifact.extension}`])),
    mimeType: artifact.mimeType };
}

let working = false;
let pendingWake = false;
export function wakeDraftWorker() {
  pendingWake = true;
  if (working) return;
  working = true;
  void (async () => {
    try {
      while (pendingWake) {
        pendingWake = false;
        let job = await q("o_v04StudioAssetDraftJob").where({ status: "RUNNING" }).orderBy("startedAt").first();
        let freshClaim = false;
        if (!job) {
          job = await q("o_v04StudioAssetDraftJob").where({ status: "QUEUED" }).orderBy("createdAt").first();
          if (!job) break;
          const changed = await q("o_v04StudioAssetDraftJob").where({ id: job.id, status: "QUEUED" })
            .update({ status: "RUNNING", startedAt: Date.now(), updatedAt: Date.now() });
          if (changed !== 1) { pendingWake = true; continue; }
          freshClaim = true;
        }
        await produce(job, freshClaim);
        pendingWake = true;
      }
    } catch (error) { console.error("[V04 DraftImage][Worker]", { errorName: error instanceof Error ? error.name : "Error" }); }
    finally { working = false; if (pendingWake) wakeDraftWorker(); }
  })();
}

async function produce(job: any, freshClaim: boolean) {
  if (job.generationIntent === "ASSET_IMAGE_EDIT") return produceAssetImageEdit(job, freshClaim);
  try {
    const snapshot = JSON.parse(job.inputSnapshotJson);
    if (!freshClaim && !job.comfyPromptId)
      throw new DraftComfyError("EXECUTION_FAILED", "上次运行结果不确定，请人工重试草图任务");
    if (!job.comfyPromptId) {
      let source: Awaited<ReturnType<typeof sourceSnapshot>>;
      try { source = await sourceSnapshot({ projectId: job.projectId, scriptId: job.scriptId,
        canonicalKey: job.canonicalKey, sourceAssetRevision: job.sourceAssetRevision,
        visualSpecDraft: snapshot.visualSpecDraft, force: false }); }
      catch { await q("o_v04StudioAssetDraftJob").where({ id: job.id, status: "RUNNING" }).update({ status: "STALE", errorCode: "STALE_JOB", updatedAt: Date.now() }); return; }
      const config = await q("o_v04StudioImageExecutorConfig").where({ projectId: job.projectId }).first();
      if (!config?.enabled || snapshotHash(source, config, { width: snapshot.width ?? 1024,
        height: snapshot.height ?? 1024, requestedSeed: snapshot.requestedSeed ?? undefined, executionPurpose: job.executionPurpose }) !== job.draftHash) {
        await q("o_v04StudioAssetDraftJob").where({ id: job.id, status: "RUNNING" }).update({ status: "STALE", errorCode: "STALE_JOB", updatedAt: Date.now() });
        return;
      }
    }
    const base = localComfyOrigin(snapshot.baseUrl);
    const profile = job.executorProfile ?? LOCAL_DRAFT_V1;
    const workflow = buildDraftWorkflow({ intent: job.generationIntent, checkpoint: snapshot.checkpoint,
      positive: job.executionPurpose ? snapshot.executionPrompt : profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? snapshot.executionPrompt : snapshot.draftRenderedPrompt.text,
      negative: profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? "" : snapshot.draftRenderedPrompt.negative || "",
      seed: snapshot.seed ?? parseInt(job.draftHash.slice(0, 12), 16), profile,
      width: snapshot.width, height: snapshot.height,
      filenamePrefix: profile === Z_IMAGE_TURBO_SUBJECT_DRAFT_V1 ? `DreamStreamV04ZSubject_${job.id.slice(0, 8)}` : undefined });
    if (job.executionPurpose) workflow.role = job.executionPurpose === "SUBJECT_MAIN_PREVIEW" ? "MAIN_PREVIEW" : job.executionPurpose;
    const inspection = await inspectComfy(base, profile);
    if (inspection.status === "UNAVAILABLE") throw new DraftComfyError("COMFY_OFFLINE", "本地 ComfyUI 未运行");
    if (inspection.missingNodes.length) throw new DraftComfyError("NODE_MISSING", "本地 ComfyUI 缺少草图节点");
    if (inspection.missingModels.length) throw new DraftComfyError("MODEL_MISSING", "本地 ComfyUI 缺少 Z-Image 模型文件");
    if (!inspection.checkpoints.includes(snapshot.checkpoint)) throw new DraftComfyError("MODEL_MISSING", "配置的 checkpoint 已不存在");
    const promptId = job.comfyPromptId ?? await submitTracedDraft(base, workflow, job);
    if (!job.comfyPromptId) await q("o_v04StudioAssetDraftJob").where({ id: job.id }).update({ comfyPromptId: promptId, updatedAt: Date.now() });
    job.comfyPromptId = promptId;
    const image = await awaitDraft(base, promptId, workflow.outputNode);
    const downloaded = await downloadDraft(base, image);
    const artifactId = randomUUID();
    const artifactPath = getPath(["v04-draft-artifacts", String(job.projectId), `${artifactId}.${downloaded.extension}`]);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, downloaded.bytes, { flag: "wx" });
    const artifact = { artifactId, role: workflow.role, mimeType: downloaded.mimeType,
      fileRef: `/api/v04/studio/artifact/${job.projectId}/${artifactId}`,
      width: downloaded.width, height: downloaded.height, createdAt: Date.now() };
    let source: Awaited<ReturnType<typeof sourceSnapshot>> | null = null;
    try { source = await sourceSnapshot({ projectId: job.projectId, scriptId: job.scriptId,
      canonicalKey: job.canonicalKey, sourceAssetRevision: job.sourceAssetRevision,
      visualSpecDraft: snapshot.visualSpecDraft, force: false }); }
    catch { /* The source may have changed while Comfy was running. Keep its output as history. */ }
    const currentConfig = await q("o_v04StudioImageExecutorConfig").where({ projectId: job.projectId }).first();
    const stillFresh = source && currentConfig?.enabled && snapshotHash(source, currentConfig, {
      width: snapshot.width ?? 1024, height: snapshot.height ?? 1024,
      requestedSeed: snapshot.requestedSeed ?? undefined, executionPurpose: job.executionPurpose }) === job.draftHash;
    await q.transaction(async trx => {
      await trx("o_v04StudioDraftArtifact").insert({ artifactId, jobId: job.id, projectId: job.projectId,
        mimeType: downloaded.mimeType, extension: downloaded.extension, role: workflow.role,
        width: downloaded.width, height: downloaded.height, createdAt: artifact.createdAt });
      const latest = await trx("o_v04StudioAssetDraftJob").where({ id: job.id }).first();
      if (latest?.status === "RUNNING") await trx("o_v04StudioAssetDraftJob").where({ id: job.id, status: "RUNNING" }).update({
        status: stillFresh ? "SUCCEEDED" : "STALE", outputsJson: JSON.stringify([artifact]),
        completedAt: Date.now(), updatedAt: Date.now() });
      else if (latest?.status === "STALE") await trx("o_v04StudioAssetDraftJob").where({ id: job.id, status: "STALE" }).update({
        outputsJson: JSON.stringify([artifact]), completedAt: Date.now(), updatedAt: Date.now() });
    });
  } catch (error) {
    const failure = safeFailure(error);
    await failSubmittedTrace(job,failure.code);
    await q("o_v04StudioAssetDraftJob").where({ id: job.id, status: "RUNNING" }).update({ status: "FAILED",
      errorCode: failure.code, errorMessage: failure.message, completedAt: Date.now(), updatedAt: Date.now() });
  } finally { await settleJobTraces(job.id); }
}

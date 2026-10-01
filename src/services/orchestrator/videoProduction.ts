import { createHash } from "node:crypto";
import type { Knex } from "knex";
import u from "@/utils";
import type { ReferenceList } from "@/utils/ai";
import { canonicalJson, sha256 } from "@/services/supervisor/contract";
import { resolveModelsInTransaction } from "@/services/modelPreset";
import { ProfileError } from "./profileDefinition";
import { acquireRevisionBoundary, currentRevisionEpoch } from "./revisionBoundary";
import { assertCurrentPermission, createRevisionWorkGuardInTransaction, ownedActiveRevisionWork,
  settleRevisionWorkInTransaction, type RevisionWorkGuard } from "./revisionWorkGuard";
import { assertActiveManagedTrack } from "./revisionWriteSafety";
import { assertVideoOperationAllowedInTransaction, classifyVideoProfile } from "./videoProductionProfile";

const db = () => u.db as Knex;
export const videoSourceAdapter = "video.track-source.v1";
type Scope = { projectId: number; scriptId: number };
type RefInput = { id: number; sources: string };
type GenerateItem = { trackId: number; references: RefInput[]; prompt: string; duration: number; videoPath: string };
type GenerateOptions = { model?: string; mode: string; resolution: string; audio?: boolean };
type ReservedReference = { sourceKind: "storyboard" | "assets"; sourceId: number; filePath: string; identity: any; mediaTypeHint: string | null };
type NormalizedMode = string | string[];
type MaterializedReference = ReservedReference & { role: string; mediaType: "image" | "video" | "audio"; mime: string;
  proof: { sha256: string; byteLength: number; mime: string }; base64: string };

const fail = (code: string, message: string, status = 409): never => { throw new ProfileError(code, message, status); };
const hashBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash64 = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function normalizeVideoMode(value: unknown): NormalizedMode {
  if (Array.isArray(value)) {
    if (!value.every(item => typeof item === "string")) fail("VIDEO_MODEL_MODE_UNSUPPORTED", "视频模式字段不合法");
    return value.map(String);
  }
  if (typeof value !== "string" || !value) fail("VIDEO_MODEL_MODE_UNSUPPORTED", "视频模式字段不合法");
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) throw new Error();
      return parsed.map(String);
    } catch { fail("VIDEO_MODEL_MODE_UNSUPPORTED", "视频多参考模式字段不合法"); }
  }
  return value;
}
const normalizedModeKey = (value: unknown) => JSON.stringify(normalizeVideoMode(value));
const normalizedReason = (value: unknown) => {
  if (value == null) return null;
  if (typeof value !== "string") fail("VIDEO_ACCEPTANCE_ID_CONFLICT", "Accept reason 字段不合法", 400);
  const reason = value.trim();
  if (!reason) return null;
  if (reason.length > 1000) fail("VIDEO_ACCEPTANCE_ID_CONFLICT", "Accept reason 超过长度限制", 400);
  return reason;
};
const effectiveRatio = (project: any) => String(project?.videoRatio || "16:9");

async function currentModel(q: Knex.Transaction, projectId: number, requestModel?: string) {
  const project = await q("o_project").where({ id: projectId }).first();
  if (!project) fail("REVISION_WORK_SCOPE_INVALID", "项目不存在", 404);
  const resolved = (await resolveModelsInTransaction(projectId, q, project)).models.video;
  if (!resolved) fail("VIDEO_MODEL_UNAVAILABLE", "请先配置视频生成模型");
  if (requestModel && requestModel !== resolved) fail("MODEL_CONFIG_MISMATCH", "所选模型与当前项目配置不同，请刷新后重试");
  return { project, model: resolved };
}

async function referenceReservation(q: Knex.Transaction, scope: Scope, trackId: number, ref: RefInput): Promise<ReservedReference> {
  if (!positive(ref.id)) fail("REVISION_WORK_SCOPE_INVALID", "参考素材 ID 无效");
  if (ref.sources === "storyboard") {
    const row = await q("o_storyboard").where({ ...scope, id: ref.id, trackId }).whereNull("retiredAt")
      .first("id", "filePath", "currentImageAttemptId");
    if (!row?.filePath) fail("VIDEO_REFERENCE_UNSUPPORTED", "当前分镜参考图片不可用");
    return { sourceKind: "storyboard", sourceId: Number(row.id), filePath: row.filePath,
      identity: { storyboardId: Number(row.id), currentImageAttemptId: row.currentImageAttemptId ?? null, filePath: row.filePath },
      mediaTypeHint: "image" };
  }
  if (ref.sources === "assets") {
    const asset = await q("o_assets").where({ projectId: scope.projectId, id: ref.id }).first("id", "scriptId", "imageId");
    const linked = await q("o_scriptAssets").where({ scriptId: scope.scriptId, assetId: ref.id }).first("assetId");
    if (!asset || asset.scriptId != null && Number(asset.scriptId) !== scope.scriptId || !linked || !asset.imageId)
      fail("REVISION_WORK_SCOPE_INVALID", "参考素材不属于当前制作单元");
    const image = await q("o_image").where({ id: asset.imageId }).first("id", "filePath", "type", "state");
    if (!image?.filePath || image.state === "生成失败") fail("VIDEO_REFERENCE_UNSUPPORTED", "当前素材媒体不可用");
    return { sourceKind: "assets", sourceId: Number(asset.id), filePath: image.filePath,
      identity: { assetId: Number(asset.id), imageId: Number(image.id), filePath: image.filePath, storedType: image.type ?? null },
      mediaTypeHint: image.type ?? null };
  }
  fail("VIDEO_REFERENCE_UNSUPPORTED", "参考素材来源类型不支持");
}

async function reserveReferences(q: Knex.Transaction, scope: Scope, trackId: number, refs: RefInput[]) {
  if (refs.length > 200) fail("REVISION_WORK_SCOPE_INVALID", "参考素材超过上限");
  const out: ReservedReference[] = [];
  for (const ref of refs) out.push(await referenceReservation(q, scope, trackId, ref));
  return out;
}

function looksImage(bytes: Buffer) {
  return bytes.length >= 4 && (
    bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) ||
    bytes[0] === 0xff && bytes[1] === 0xd8 ||
    bytes.subarray(0, 3).toString("ascii") === "GIF" ||
    bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
function looksVideo(bytes: Buffer) {
  return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" ||
    bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
}
function looksAudio(bytes: Buffer) {
  return bytes.length >= 4 && (
    bytes.subarray(0, 3).toString("ascii") === "ID3" ||
    bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 ||
    bytes.subarray(0, 4).toString("ascii") === "OggS" ||
    bytes.subarray(0, 4).toString("ascii") === "fLaC" ||
    bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}
function normalizedHint(value: string | null): "image" | "video" | "audio" | null {
  const v = String(value ?? "").toLowerCase();
  if (v === "image" || v.startsWith("image/")) return "image";
  if (v === "video" || v.startsWith("video/") || v === "clip") return "video";
  if (v === "audio" || v.startsWith("audio/")) return "audio";
  return null;
}
function mediaDescriptor(bytes: Buffer, hint: string | null) {
  let type: "image" | "video" | "audio";
  const hinted = normalizedHint(hint);
  if (hinted === "image" && looksImage(bytes)) type = "image";
  else if (hinted === "video" && looksVideo(bytes)) type = "video";
  else if (hinted === "audio" && looksAudio(bytes)) type = "audio";
  else if (looksImage(bytes)) type = "image";
  else if (looksVideo(bytes)) type = "video";
  else if (looksAudio(bytes)) type = "audio";
  else fail("VIDEO_REFERENCE_UNSUPPORTED", "参考媒体字节类型无法验证");
  let mime = type === "image" ? "image/jpeg" : type === "video" ? "video/mp4" : "audio/mpeg";
  if (type === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) mime = "image/png";
    else if (bytes.subarray(0, 3).toString("ascii") === "GIF") mime = "image/gif";
    else if (bytes.subarray(0, 4).toString("ascii") === "RIFF") mime = "image/webp";
  } else if (type === "video") {
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) mime = "video/webm";
    else if (bytes.subarray(8, 12).toString("ascii") === "qt  ") mime = "video/quicktime";
  } else {
    if (bytes.subarray(0, 4).toString("ascii") === "OggS") mime = "audio/ogg";
    else if (bytes.subarray(0, 4).toString("ascii") === "fLaC") mime = "audio/flac";
    else if (bytes.subarray(0, 4).toString("ascii") === "RIFF") mime = "audio/wav";
  }
  return { type, mime };
}
function roles(mode: NormalizedMode, types: Array<"image" | "video" | "audio">) {
  if (typeof mode === "string") {
    if (mode === "text") {
      if (types.length) fail("VIDEO_REFERENCE_UNSUPPORTED", "文本生视频模式不接受参考素材");
      return [];
    }
    if (mode === "singleImage") {
      if (types.length !== 1 || types[0] !== "image") fail("VIDEO_REFERENCE_UNSUPPORTED", "单图模式需要恰好一张图片");
      return ["imageReference"];
    }
    if (mode === "startEndRequired") {
      if (types.length !== 2 || types.some(type => type !== "image")) fail("VIDEO_REFERENCE_UNSUPPORTED", "首尾帧模式需要两张图片");
      return ["startImage", "endImage"];
    }
    if (mode === "endFrameOptional") {
      if (types.length < 1 || types.length > 2 || types.some(type => type !== "image")) fail("VIDEO_REFERENCE_UNSUPPORTED", "尾帧可选模式需要一到两张图片");
      return types.length === 1 ? ["startImage"] : ["startImage", "endImage"];
    }
    if (mode === "startFrameOptional") {
      if (types.length < 1 || types.length > 2 || types.some(type => type !== "image")) fail("VIDEO_REFERENCE_UNSUPPORTED", "首帧可选模式需要一到两张图片");
      return types.length === 1 ? ["endImage"] : ["startImage", "endImage"];
    }
    fail("VIDEO_MODEL_MODE_UNSUPPORTED", "视频模式不受支持");
  }
  if (!types.length) fail("VIDEO_REFERENCE_UNSUPPORTED", "多参考模式至少需要一个参考素材");
  const limits: Record<string, number> = {};
  for (const value of mode) {
    const match = /^(imageReference|videoReference|audioReference|textReference):(\d+)$/.exec(value);
    if (!match) fail("VIDEO_MODEL_MODE_UNSUPPORTED", "多参考模式声明不合法");
    if (match[1] === "textReference") fail("VIDEO_REFERENCE_UNSUPPORTED", "001E 首版不支持 textReference");
    limits[match[1]] = Number(match[2]);
  }
  const counts: Record<string, number> = {};
  return types.map(type => {
    const role = type === "image" ? "imageReference" : type === "video" ? "videoReference" : "audioReference";
    if (!(role in limits)) fail("VIDEO_REFERENCE_UNSUPPORTED", "所选参考媒体类型未被当前模式声明");
    counts[role] = (counts[role] ?? 0) + 1;
    if (counts[role] > limits[role]) fail("VIDEO_REFERENCE_UNSUPPORTED", "参考媒体数量超过当前模式上限");
    return role;
  });
}

async function modelDescriptor(model: string, mode: NormalizedMode, refs: MaterializedReference[],
  duration: number, resolution: string, audio: boolean) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  const vendor = await db()("o_vendorConfig").where({ id: vendorId, enable: 1 }).first("id");
  if (!vendor) fail("VIDEO_MODEL_UNAVAILABLE", "视频模型供应商不可用");
  let models: any[];
  try { models = await u.vendor.getModelList(vendorId); }
  catch { fail("VIDEO_MODEL_UNAVAILABLE", "视频模型列表不可用"); }
  const descriptor = models.find((item: any) => item.modelName === modelName && item.type === "video");
  if (!descriptor) fail("VIDEO_MODEL_UNAVAILABLE", "当前视频模型不可用");
  const modes = Array.isArray(descriptor.mode) ? descriptor.mode : [];
  if (!modes.some((candidate: any) => {
    try { return normalizedModeKey(candidate) === JSON.stringify(mode); } catch { return false; }
  })) fail("VIDEO_MODEL_MODE_UNSUPPORTED", "当前视频模型不支持所选模式");
  const dr = Array.isArray(descriptor.durationResolutionMap) ? descriptor.durationResolutionMap : [];
  if (dr.length && !dr.some((item: any) => (!Array.isArray(item.duration) || item.duration.includes(duration)) &&
    (!Array.isArray(item.resolution) || item.resolution.includes(resolution)))) {
    fail("VIDEO_MODEL_MODE_UNSUPPORTED", "当前视频模型不支持所选时长或分辨率");
  }
  if (audio && !(descriptor.audio === true || descriptor.audio === "true" || descriptor.audio === "optional"))
    fail("VIDEO_MODEL_MODE_UNSUPPORTED", "当前视频模型不支持音频输出");
  if (refs.some(ref => ref.mediaType !== "image")) {
    const version = Number.parseFloat(String(u.vendor.getVendor(vendorId)?.version ?? ""));
    if (!Number.isFinite(version) || version < 2) fail("VIDEO_REFERENCE_UNSUPPORTED", "当前供应商适配器不支持非图片参考");
  }
}

async function providerUncertain(q: Knex.Transaction, scope: Scope, trackId: number) {
  const rows = await q("o_revisionWorkGuard").where(scope).where({ trackId, kind: "VIDEO_GENERATE", state: "UNCERTAIN" })
    .select("resolutionJson");
  return rows.some(row => {
    try { return JSON.parse(row.resolutionJson || "{}").code === "PROVIDER_SUBMISSION_UNCERTAIN"; }
    catch { return false; }
  });
}

export async function reserveE001VideoGeneration(scope: Scope, items: GenerateItem[], options: GenerateOptions) {
  if (!items.length || items.length > 200) fail("REVISION_WORK_SCOPE_INVALID", "视频任务为空或超过上限");
  return db().transaction(async q => {
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    const cls = await assertVideoOperationAllowedInTransaction(q, "video.generate", scope);
    if (cls !== "E001_ENABLED") fail("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前 Profile 不属于 001E 视频生产");
    const epoch = await currentRevisionEpoch(q, scope.projectId, scope.scriptId);
    await assertCurrentPermission(q, scope, epoch);
    const { project, model } = await currentModel(q, scope.projectId, options.model);
    const mode = normalizeVideoMode(options.mode);
    const guards: RevisionWorkGuard[] = [];
    for (const item of items) {
      const track = await q("o_videoTrack").where({ ...scope, id: item.trackId }).first();
      if (!track) fail("REVISION_WORK_SCOPE_INVALID", "视频轨道不属于当前制作单元");
      await assertActiveManagedTrack(q, scope, track);
      if (String(track.prompt ?? "") !== String(item.prompt ?? "")) fail("VIDEO_SOURCE_CHANGED", "视频提示词已变化，请刷新后重试");
      if (!Number.isFinite(Number(item.duration)) || Number(track.duration ?? 0) !== Number(item.duration))
        fail("VIDEO_SOURCE_CHANGED", "视频时长已变化，请刷新后重试");
      if (await providerUncertain(q, scope, item.trackId))
        fail("VIDEO_GENERATION_UNCERTAIN_BLOCKED", "该轨道存在可能已提交到供应商的未决视频任务，请先人工恢复");
      const refs = await reserveReferences(q, scope, item.trackId, item.references);
      const reserved = {
        adapterKey: videoSourceAdapter, phase: "RESERVED", revisionEpoch: epoch,
        subject: { ...scope, trackId: item.trackId },
        execution: { prompt: String(track.prompt ?? ""), duration: Number(track.duration ?? 0), model,
          aspectRatio: effectiveRatio(project), mode, resolution: String(options.resolution),
          audio: Boolean(options.audio), references: refs },
      };
      guards.push(await createRevisionWorkGuardInTransaction(q, scope, "VIDEO_GENERATE",
        { trackId: item.trackId, references: item.references, videoPath: item.videoPath }, epoch,
        { sourceAdapter: videoSourceAdapter, sourceSnapshot: canonicalJson(reserved), sourceHash: null }));
    }
    return { guards, model };
  });
}

function parseReserved(video: any) {
  if (video?.sourceAdapter !== videoSourceAdapter || !video.sourceSnapshot) fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频候选缺少 001E Source 预留证据");
  let source: any;
  try { source = JSON.parse(video.sourceSnapshot); } catch { fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频候选 Source 证据损坏"); }
  if (source.adapterKey !== videoSourceAdapter) fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频候选 Source adapter 不匹配");
  return source;
}
async function materialize(reserved: any) {
  const refs = reserved.execution.references as ReservedReference[];
  const temp: Array<Omit<MaterializedReference, "role">> = [];
  for (const ref of refs) {
    let bytes: Buffer;
    try { bytes = await u.oss.getFile(ref.filePath); }
    catch { fail("VIDEO_REFERENCE_UNSUPPORTED", "参考媒体文件不可读取"); }
    const { type, mime } = mediaDescriptor(bytes, ref.mediaTypeHint);
    temp.push({ ...ref, mediaType: type, mime,
      proof: { sha256: hashBytes(bytes), byteLength: bytes.length, mime },
      base64: `data:${mime};base64,${bytes.toString("base64")}` });
  }
  const assigned = roles(reserved.execution.mode, temp.map(ref => ref.mediaType));
  return temp.map((ref, index) => ({ ...ref, role: assigned[index] })) as MaterializedReference[];
}
async function recapture(q: Knex.Transaction, scope: Scope, reserved: any) {
  const trackId = Number(reserved.subject.trackId);
  const track = await q("o_videoTrack").where({ ...scope, id: trackId }).first();
  if (!track) fail("VIDEO_SOURCE_CHANGED", "视频轨道已变化");
  await assertActiveManagedTrack(q, scope, track);
  const epoch = await currentRevisionEpoch(q, scope.projectId, scope.scriptId);
  const { project, model } = await currentModel(q, scope.projectId);
  const refs = await reserveReferences(q, scope, trackId, (reserved.execution.references as ReservedReference[])
    .map(ref => ({ id: ref.sourceId, sources: ref.sourceKind })));
  return { epoch, track, project, model, refs };
}
function sameReservation(reserved: any, captured: Awaited<ReturnType<typeof recapture>>) {
  return reserved.revisionEpoch === captured.epoch &&
    reserved.execution.prompt === String(captured.track.prompt ?? "") &&
    Number(reserved.execution.duration) === Number(captured.track.duration ?? 0) &&
    reserved.execution.model === captured.model &&
    reserved.execution.aspectRatio === effectiveRatio(captured.project) &&
    canonicalJson((reserved.execution.references as ReservedReference[]).map(ref => ({
      sourceKind: ref.sourceKind, sourceId: ref.sourceId, filePath: ref.filePath, identity: ref.identity,
    }))) === canonicalJson(captured.refs.map(ref => ({
      sourceKind: ref.sourceKind, sourceId: ref.sourceId, filePath: ref.filePath, identity: ref.identity,
    })));
}

export async function sealE001VideoSource(scope: Scope, guard: RevisionWorkGuard) {
  const video = await db()("o_video").where({ ...scope, id: guard.videoId, videoTrackId: guard.trackId,
    revisionWorkGuardId: guard.guardId }).first();
  const reserved = parseReserved(video);
  if (reserved.phase !== "RESERVED") fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频候选不处于 Source 预留状态");
  const refs = await materialize(reserved);
  await modelDescriptor(reserved.execution.model, reserved.execution.mode, refs,
    Number(reserved.execution.duration), String(reserved.execution.resolution), Boolean(reserved.execution.audio));
  return db().transaction(async q => {
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    await ownedActiveRevisionWork(q, scope, guard);
    const cls = await assertVideoOperationAllowedInTransaction(q, "video.generate", scope);
    if (cls !== "E001_ENABLED") fail("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前 Profile 已变化");
    await assertCurrentPermission(q, scope, guard.admittedEpoch);
    const captured = await recapture(q, scope, reserved);
    if (!sameReservation(reserved, captured)) fail("VIDEO_SOURCE_CHANGED", "视频 Source 在提交供应商前已变化");
    const source = {
      adapterKey: videoSourceAdapter,
      revisionEpoch: reserved.revisionEpoch,
      subject: reserved.subject,
      execution: {
        prompt: reserved.execution.prompt, duration: reserved.execution.duration, model: reserved.execution.model,
        aspectRatio: reserved.execution.aspectRatio, mode: reserved.execution.mode, resolution: reserved.execution.resolution,
        audio: reserved.execution.audio,
        references: refs.map(ref => ({ sourceKind: ref.sourceKind, sourceId: ref.sourceId, role: ref.role,
          mediaType: ref.mediaType, identity: ref.identity, proof: ref.proof })),
      },
    };
    const sourceHash = sha256(source);
    const changed = await q("o_video").where({ ...scope, id: guard.videoId, revisionWorkGuardId: guard.guardId })
      .whereNull("sourceHash").update({ sourceSnapshot: canonicalJson(source), sourceHash });
    if (changed !== 1) fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频 Source 已被其他执行写入");
    return {
      model: source.execution.model, prompt: source.execution.prompt, duration: source.execution.duration,
      aspectRatio: source.execution.aspectRatio, mode: source.execution.mode, resolution: source.execution.resolution,
      audio: source.execution.audio, sourceHash,
      referenceList: refs.map(ref => ({ type: ref.mediaType, base64: ref.base64 })) as ReferenceList[],
    };
  });
}

export async function finishE001VideoCandidate(scope: Scope, guard: RevisionWorkGuard,
  output: { filePath: string; mime: string; sha256: string; byteLength: number }) {
  return db().transaction(async q => {
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    await ownedActiveRevisionWork(q, scope, guard);
    const video = await q("o_video").where({ ...scope, id: guard.videoId, videoTrackId: guard.trackId,
      revisionWorkGuardId: guard.guardId }).first();
    if (!video || video.sourceAdapter !== videoSourceAdapter || !video.sourceHash || output.filePath !== video.filePath ||
      output.mime !== "video/mp4" || !hash64(output.sha256) || !Number.isSafeInteger(output.byteLength) || output.byteLength <= 0)
      fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频输出证明与候选不匹配");
    if (video.outputSha256 && (video.outputSha256 !== output.sha256 || video.outputMime !== output.mime ||
      Number(video.outputByteLength) !== output.byteLength)) fail("VIDEO_OUTPUT_PROVENANCE_MISMATCH", "视频输出证明已存在且不一致");
    if (!video.outputSha256) await q("o_video").where({ id: video.id }).update({
      outputMime: output.mime, outputSha256: output.sha256, outputByteLength: output.byteLength,
    });
    return settleRevisionWorkInTransaction(q, scope, guard, "SUCCEEDED");
  });
}

export async function failE001VideoCandidate(scope: Scope, guard: RevisionWorkGuard, error: unknown) {
  try {
    return await db().transaction(async q => {
      await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
      return settleRevisionWorkInTransaction(q, scope, guard, "FAILED",
        { error: error instanceof Error ? error.message : String(error) });
    });
  } catch { return "FENCED" as const; }
}

async function sourceStillCurrent(q: Knex.Transaction, scope: Scope, video: any) {
  if (video.sourceAdapter !== videoSourceAdapter || !video.sourceSnapshot || !video.sourceHash) return false;
  let source: any;
  try { source = JSON.parse(video.sourceSnapshot); } catch { return false; }
  if (sha256(source) !== video.sourceHash || source.adapterKey !== videoSourceAdapter) return false;
  const synthetic = { ...source, execution: { ...source.execution,
    references: source.execution.references.map((ref: any) => ({
      sourceKind: ref.sourceKind, sourceId: ref.sourceId, filePath: ref.identity?.filePath,
      identity: ref.identity, mediaTypeHint: ref.mediaType,
    })) } };
  let captured;
  try { captured = await recapture(q, scope, synthetic); } catch { return false; }
  return source.revisionEpoch === captured.epoch &&
    source.execution.prompt === String(captured.track.prompt ?? "") &&
    Number(source.execution.duration) === Number(captured.track.duration ?? 0) &&
    source.execution.model === captured.model &&
    source.execution.aspectRatio === effectiveRatio(captured.project) &&
    canonicalJson(source.execution.references.map((ref: any) => ({ sourceKind: ref.sourceKind, sourceId: ref.sourceId, identity: ref.identity }))) ===
      canonicalJson(captured.refs.map(ref => ({ sourceKind: ref.sourceKind, sourceId: ref.sourceId, identity: ref.identity })));
}

export type CandidateProjection = { status: "GENERATING" | "FAILED" | "UNRESOLVED" | "RETIRED" | "STALE" | "SELECTION_ELIGIBLE";
  selectionEligible: boolean; workGuardState: string | null };
export async function assessE001Candidate(q: Knex.Transaction, scope: Scope, video: any): Promise<CandidateProjection> {
  if (!video || Number(video.projectId) !== scope.projectId || Number(video.scriptId) !== scope.scriptId ||
    video.sourceAdapter !== videoSourceAdapter) return { status: "STALE", selectionEligible: false, workGuardState: null };
  if (video.retiredAt != null) return { status: "RETIRED", selectionEligible: false, workGuardState: null };
  const guard = video.revisionWorkGuardId ? await q("o_revisionWorkGuard").where({ ...scope, guardId: video.revisionWorkGuardId,
    kind: "VIDEO_GENERATE", trackId: video.videoTrackId }).first() : null;
  if (!guard) return { status: "STALE", selectionEligible: false, workGuardState: null };
  if (guard.state === "ACTIVE") return { status: "GENERATING", selectionEligible: false, workGuardState: guard.state };
  if (guard.state === "UNCERTAIN") return { status: "UNRESOLVED", selectionEligible: false, workGuardState: guard.state };
  if (guard.state === "FENCED") return { status: "STALE", selectionEligible: false, workGuardState: guard.state };
  if (guard.state !== "SETTLED" || guard.outcome !== "SUCCEEDED" || video.state !== "生成成功")
    return { status: "FAILED", selectionEligible: false, workGuardState: guard.state };
  if (!video.sourceHash || !video.outputSha256 || video.outputMime !== "video/mp4" ||
    !hash64(video.sourceHash) || !hash64(video.outputSha256) || !Number.isSafeInteger(Number(video.outputByteLength)) ||
    Number(video.outputByteLength) <= 0) return { status: "UNRESOLVED", selectionEligible: false, workGuardState: guard.state };
  if (!await sourceStillCurrent(q, scope, video)) return { status: "STALE", selectionEligible: false, workGuardState: guard.state };
  return { status: "SELECTION_ELIGIBLE", selectionEligible: true, workGuardState: guard.state };
}

export async function acceptedCurrentForTrack(q: Knex.Transaction, scope: Scope, track: any) {
  if (!track?.videoId) return null;
  const video = await q("o_video").where({ ...scope, id: track.videoId, videoTrackId: track.id }).first();
  const assessment = await assessE001Candidate(q, scope, video);
  if (!assessment.selectionEligible) return null;
  const acceptance = await q("o_videoAcceptance").where({ ...scope, trackId: track.id, videoId: video.id,
    candidateSourceHash: video.sourceHash, candidateOutputSha256: video.outputSha256 }).orderBy("acceptedAt", "desc").first();
  return acceptance ? { video, acceptance, assessment } : null;
}

export async function readVideoProductionProjection(projectId: number, scriptId: number, videos: any[], tracks: any[]) {
  return db().transaction(async q => {
    const profileClass = await classifyVideoProfile(q, projectId);
    if (profileClass === "MANAGED_V2_UNSUPPORTED") fail("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前受控 Profile 未声明受支持的视频生产合同");
    if (profileClass !== "E001_ENABLED") return null;
    const scope = { projectId, scriptId }, candidates: Record<number, CandidateProjection> = {}, accepted: Record<number, number> = {};
    for (const video of videos) candidates[Number(video.id)] = await assessE001Candidate(q, scope, video);
    for (const track of tracks) {
      const current = await acceptedCurrentForTrack(q, scope, track);
      if (current) accepted[Number(track.id)] = Number(current.video.id);
    }
    return { candidates, accepted };
  });
}

export async function readAcceptedCurrentMaterial(projectId: number, scriptId: number) {
  return db().transaction(async q => {
    const profileClass = await classifyVideoProfile(q, projectId);
    if (profileClass === "MANAGED_V2_UNSUPPORTED") fail("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前受控 Profile 未声明受支持的视频生产合同");
    if (profileClass !== "E001_ENABLED") return null;
    const scope = { projectId, scriptId }, tracks = await q("o_videoTrack").where(scope), result: any[] = [];
    for (const track of tracks) {
      const current = await acceptedCurrentForTrack(q, scope, track);
      if (current) result.push({ trackId: Number(track.id), videoId: Number(current.video.id), filePath: current.video.filePath,
        sourceHash: current.video.sourceHash, outputSha256: current.video.outputSha256 });
    }
    return result;
  });
}

export async function acceptE001Video(input: { projectId: number; scriptId: number; trackId: number; videoId: number;
  acceptanceId: string; reason?: string | null }, actor: any) {
  const reason = normalizedReason(input.reason);
  return db().transaction(async q => {
    const actorId = Number(actor?.id);
    if (!Number.isSafeInteger(actorId) || actorId <= 0) fail("REVISION_ACCESS_DENIED", "无法确认当前操作人", 403);
    const user = await q("o_user").where({ id: actorId }).first("id", "name");
    if (!user) fail("REVISION_ACCESS_DENIED", "当前账号不存在", 403);
    if (!await q("o_script").where({ id: input.scriptId, projectId: input.projectId }).first("id"))
      fail("REVISION_WORK_SCOPE_INVALID", "制作单元不存在或不属于当前项目", 404);
    await acquireRevisionBoundary(q, input.projectId, input.scriptId);
    const prior = await q("o_videoAcceptance").where({ acceptanceId: input.acceptanceId }).first();
    if (prior) {
      const same = Number(prior.projectId) === input.projectId && Number(prior.scriptId) === input.scriptId &&
        Number(prior.trackId) === input.trackId && Number(prior.videoId) === input.videoId &&
        Number(prior.actorUserId) === actorId && (prior.reason ?? null) === reason;
      if (!same) fail("VIDEO_ACCEPTANCE_ID_CONFLICT", "此 acceptanceId 已用于其他 Accept 命令");
      return { delivery: "REPLAYED" as const, acceptanceId: prior.acceptanceId, trackId: Number(prior.trackId),
        videoId: Number(prior.videoId), acceptedAt: Number(prior.acceptedAt) };
    }
    const cls = await assertVideoOperationAllowedInTransaction(q, "video.accept", input);
    if (cls !== "E001_ENABLED") fail("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前 Profile 不属于 001E 视频生产");
    const track = await q("o_videoTrack").where({ projectId: input.projectId, scriptId: input.scriptId, id: input.trackId }).first();
    if (!track) fail("REVISION_WORK_SCOPE_INVALID", "视频轨道不存在");
    await assertActiveManagedTrack(q, input, track);
    const live = await q("o_revisionWorkGuard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId })
      .whereIn("state", ["ACTIVE", "UNCERTAIN"]).first("guardId");
    if (live) fail("REVISION_ASYNC_WORK_BLOCKED", "轨道存在未结算的后台任务");
    const video = await q("o_video").where({ projectId: input.projectId, scriptId: input.scriptId,
      id: input.videoId, videoTrackId: input.trackId }).first();
    if (!(await assessE001Candidate(q, { projectId: input.projectId, scriptId: input.scriptId }, video)).selectionEligible)
      fail("VIDEO_CANDIDATE_NOT_CURRENT", "候选视频不是当前可接受结果");
    const acceptedAt = Date.now();
    await q("o_videoAcceptance").insert({ acceptanceId: input.acceptanceId, projectId: input.projectId,
      scriptId: input.scriptId, trackId: input.trackId, videoId: input.videoId,
      candidateSourceHash: video.sourceHash, candidateOutputSha256: video.outputSha256,
      actorUserId: actorId, actorDisplayName: String(user.name ?? "").slice(0, 256) || null, acceptedAt, reason });
    await q("o_videoTrack").where({ projectId: input.projectId, scriptId: input.scriptId, id: input.trackId }).update({ videoId: input.videoId });
    return { delivery: "APPLIED" as const, acceptanceId: input.acceptanceId, trackId: input.trackId, videoId: input.videoId, acceptedAt };
  });
}

export async function retireE001Video(videoId: number, actor: any, reason = "Human retired candidate") {
  return db().transaction(async q => {
    const video = await q("o_video").where({ id: videoId }).first();
    if (!video) return { retired: false };
    const scope = { projectId: Number(video.projectId), scriptId: Number(video.scriptId) };
    await acquireRevisionBoundary(q, scope.projectId, scope.scriptId);
    const cls = await assertVideoOperationAllowedInTransaction(q, "video.candidate.retire", scope);
    if (cls !== "E001_ENABLED" || video.sourceAdapter !== videoSourceAdapter)
      fail("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前候选不属于 001E 视频生产");
    const live = await q("o_revisionWorkGuard").where({ ...scope, trackId: video.videoTrackId })
      .whereIn("state", ["ACTIVE", "UNCERTAIN"]).first("guardId");
    if (live) fail("REVISION_ASYNC_WORK_BLOCKED", "轨道存在未结算的后台任务");
    const actorId = Number(actor?.id);
    if (!Number.isSafeInteger(actorId) || actorId <= 0) fail("REVISION_ACCESS_DENIED", "无法确认当前操作人", 403);
    const retiredAt = Date.now();
    await q("o_video").where({ id: videoId }).update({ retiredAt, retiredByUserId: actorId, retiredReason: String(reason).slice(0, 1000) });
    await q("o_videoTrack").where({ ...scope, videoId }).update({ videoId: null });
    return { retired: true, retiredAt };
  });
}

export async function videoAcceptedCurrentGate(context: { projectId: number; scriptId: number }, q?: Knex.Transaction) {
  const read = async (trx: Knex.Transaction) => {
    if (await classifyVideoProfile(trx, context.projectId) !== "E001_ENABLED")
      return { pass: false, code: "VIDEO_PROFILE_COMPAT_UNSUPPORTED", reason: "当前 Profile 不属于 001E 视频生产" };
    const scope = { projectId: context.projectId, scriptId: context.scriptId };
    const tracks = await trx("o_videoTrack").where(scope).where({ storyboardManaged: 1 }), required: any[] = [];
    for (const track of tracks) if (await trx("o_storyboard").where({ ...scope, trackId: track.id }).whereNull("retiredAt").first("id")) required.push(track);
    if (!required.length) return { pass: false, code: "VIDEO_REQUIRED_TRACKS_EMPTY", reason: "当前没有需要完成的视频生产轨道" };
    const live = await trx("o_revisionWorkGuard").where(scope).whereIn("state", ["ACTIVE", "UNCERTAIN"])
      .whereIn("kind", ["VIDEO_GENERATE", "VIDEO_PROMPT"]).first("guardId");
    if (live) return { pass: false, code: "VIDEO_ASYNC_WORK_BLOCKED", reason: "仍有视频或提示词任务未结算" };
    for (const track of required) if (!await acceptedCurrentForTrack(trx, scope, track))
      return { pass: false, code: "VIDEO_ACCEPTED_CURRENT_REQUIRED", reason: "仍有轨道缺少当前已接受视频" };
    return { pass: true, code: "VIDEO_ACCEPTED_CURRENT_READY", reason: null };
  };
  return q ? read(q) : db().transaction(read);
}

export async function validateAcceptedVideoMaterial(input: { projectId: number; scriptId: number;
  items: Array<{ trackId: number; videoId: number; acceptedSourceHash: string; acceptedOutputSha256: string }> }) {
  if (!input.items.length || input.items.length > 200) fail("VIDEO_EDITOR_MATERIAL_STALE", "剪辑台生产视频身份为空或超过上限");
  return db().transaction(async q => {
    if (await classifyVideoProfile(q, input.projectId) !== "E001_ENABLED") fail("VIDEO_EDITOR_MATERIAL_STALE", "当前项目不是 001E 受控视频项目");
    if (!await q("o_script").where({ id: input.scriptId, projectId: input.projectId }).first("id")) fail("VIDEO_EDITOR_MATERIAL_STALE", "制作单元不存在");
    const seen = new Set<string>();
    for (const item of input.items) {
      const key = [item.trackId,item.videoId,item.acceptedSourceHash,item.acceptedOutputSha256].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      const track = await q("o_videoTrack").where({ projectId: input.projectId, scriptId: input.scriptId, id: item.trackId }).first();
      const current = track ? await acceptedCurrentForTrack(q, { projectId: input.projectId, scriptId: input.scriptId }, track) : null;
      if (!current || Number(current.video.id) !== item.videoId || current.video.sourceHash !== item.acceptedSourceHash ||
        current.video.outputSha256 !== item.acceptedOutputSha256) fail("VIDEO_EDITOR_MATERIAL_STALE", "剪辑台中的受控视频已失效，请刷新后重新选择");
    }
    return { valid: true as const };
  });
}

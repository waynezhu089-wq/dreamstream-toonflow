import u from "@/utils";
import type { ReferenceList } from "@/utils/ai";
import { markProviderSubmissionUncertain, settleRevisionWork, type RevisionWorkGuard } from "./revisionWorkGuard";
import { failE001VideoCandidate, finishE001VideoCandidate, sealE001VideoSource } from "./videoProduction";

type Scope = { projectId: number; scriptId: number };
type Item = { trackId: number; videoPath: string; uploadData: { id: number; sources: string }[]; prompt: string; duration: number };
type Options = { model: string; mode: string; resolution: string; audio?: boolean };

// Accepted predecessor worker. Keep its behavior for exact pre-001E Controlled Profiles.
export async function runControlledVideo(scope: Scope, guard: RevisionWorkGuard, item: Item, options: Options) {
  try {
    const ratio = await u.db("o_project").where({ id: scope.projectId }).first("videoRatio");
    const references: ReferenceList[] = [];
    for (const ref of item.uploadData) {
      let filePath: string | null = null, type = "image";
      if (ref.sources === "storyboard") {
        const shot = await u.db("o_storyboard").where({ ...scope, id: ref.id }).whereNull("retiredAt").first("filePath");
        filePath = shot?.filePath ?? null;
      } else if (ref.sources === "assets") {
        const asset = await u.db("o_assets").where({ projectId: scope.projectId, id: ref.id }).first("imageId");
        const image = asset?.imageId ? await u.db("o_image").where({ id: asset.imageId }).first("filePath", "type") : null;
        filePath = image?.filePath ?? null; type = image?.type ?? "image";
      }
      if (!filePath) throw new Error("受控视频输入文件不可用");
      references.push({ base64: await u.oss.getImageBase64(filePath), type: type === "audio" ? "audio" : "image" });
    }
    const mode = typeof options.mode === "string" && options.mode.startsWith('["') && options.mode.endsWith('"]') ?
      JSON.parse(options.mode) : options.mode;
    const video = u.Ai.Video(options.model as `${string}:${string}`);
    await video.run({ prompt: item.prompt, referenceList: references, mode, duration: item.duration,
      aspectRatio: (ratio?.videoRatio as `${number}:${number}`) || "16:9", resolution: options.resolution, audio: options.audio },
    { projectId: scope.projectId, taskClass: "视频生成", describe: "根据提示词生成视频",
      relatedObjects: JSON.stringify({ ...scope, videoId: guard.videoId, type: "视频" }) });
    await video.save(item.videoPath);
    await settleRevisionWork(scope, guard, "SUCCEEDED");
  } catch (error: any) {
    try { await settleRevisionWork(scope, guard, "FAILED", { error: u.error(error).message }); }
    catch (settleError) { console.error("[RevisionWorkGuard] video settlement failed", settleError); }
  }
}

export async function runE001ControlledVideo(scope: Scope, guard: RevisionWorkGuard) {
  try {
    const sealed = await sealE001VideoSource(scope, guard);
    const video = u.Ai.Video(sealed.model as `${string}:${string}`);
    try {
      await video.run({ prompt: sealed.prompt, referenceList: sealed.referenceList, mode: sealed.mode as any,
        duration: sealed.duration, aspectRatio: sealed.aspectRatio as `${number}:${number}`,
        resolution: sealed.resolution, audio: sealed.audio },
      { projectId: scope.projectId, taskClass: "视频生成", describe: "001E 受控视频生成",
        relatedObjects: JSON.stringify({ ...scope, videoId: guard.videoId, sourceHash: sealed.sourceHash, type: "视频" }) });
    } catch (error: any) {
      if (error?.providerSubmissionUncertain || error?.code === "PROVIDER_SUBMISSION_UNCERTAIN") {
        await markProviderSubmissionUncertain(scope, guard, error);
        return;
      }
      throw error;
    }
    const candidate = await u.db("o_video").where({ ...scope, id: guard.videoId, revisionWorkGuardId: guard.guardId }).first("filePath");
    if (!candidate?.filePath) throw new Error("001E 视频候选输出路径不存在");
    const proof = await video.saveWithProof(candidate.filePath);
    await finishE001VideoCandidate(scope, guard, proof);
  } catch (error: any) {
    try { await failE001VideoCandidate(scope, guard, error); }
    catch (settleError) { console.error("[001E Video] settlement failed", settleError); }
  }
}

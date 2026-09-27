import u from "@/utils";
import type { ReferenceList } from "@/utils/ai";
import { settleRevisionWork } from "./revisionWorkGuard";

type Scope = { projectId: number; scriptId: number };
type Guard = { guardId: string; trackId: number; kind: "VIDEO_GENERATE" | "VIDEO_PROMPT"; admittedEpoch: number; videoId: number | null };
type Item = { trackId: number; videoPath: string; uploadData: { id: number; sources: string }[]; prompt: string; duration: number };
type Options = { model: string; mode: string; resolution: string; audio?: boolean };

// Specialized existing video producer. The guard is already committed before
// this function may read media bytes, resolve the model or call the provider.
export async function runControlledVideo(scope: Scope, guard: Guard, item: Item, options: Options) {
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
      aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9", resolution: options.resolution, audio: options.audio },
    { projectId: scope.projectId, taskClass: "视频生成", describe: "根据提示词生成视频",
      relatedObjects: JSON.stringify({ ...scope, videoId: guard.videoId, type: "视频" }) });
    await video.save(item.videoPath);
    await settleRevisionWork(scope, guard, "SUCCEEDED");
  } catch (error: any) {
    try { await settleRevisionWork(scope, guard, "FAILED", { error: u.error(error).message }); }
    catch (settleError) { console.error("[RevisionWorkGuard] video settlement failed", settleError); }
  }
}

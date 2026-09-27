import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { admitRevisionWork } from "@/services/orchestrator/revisionWorkGuard";
import { runControlledVideo } from "@/services/orchestrator/controlledVideoWorker";
import { usesControlledRevision } from "@/services/orchestrator/revisionWriteSafety";
import { requireModel, ModelConfigError } from "@/services/modelPreset";
import { settleRevisionWork } from "@/services/orchestrator/revisionWorkGuard";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(
      z.object({
        uploadData: z.array(
          z.object({
            id: z.number(),
            sources: z.string(),
          }),
        ),
        trackId: z.number(),
        prompt: z.string(),
        duration: z.number(),
      }),
    ),
    model: z.string().optional(),
    mode: z.string(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const { scriptId, projectId, trackData, model, resolution, audio, mode } = req.body;
    const controlledItems = (trackData as { trackId: number; uploadData: { id: number; sources: string }[]; prompt: string; duration: number }[])
      .map(item => ({ ...item, videoPath: `/${projectId}/video/${uuidv4()}.mp4` }));
    let guarded;
    let controlled;
    try { controlled = await usesControlledRevision(projectId); guarded = controlled ?
      await admitRevisionWork({ projectId, scriptId }, "VIDEO_GENERATE",
        controlledItems.map(item => ({ trackId: item.trackId, references: item.uploadData, videoPath: item.videoPath }))) : null; }
    catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code ?? "REVISION_RUNTIME_UNSAFE", message: e.message }); }
    if (controlled && !guarded) return res.status(409).send({ code: "REVISION_RUNTIME_UNSAFE", message: "受控 Profile 已变化，请重试" });
    if (guarded) {
      let resolvedModel: string;
      try {
        resolvedModel = await requireModel(projectId, "video", model);
        if (model && resolvedModel !== model) throw new ModelConfigError("所选模型与当前项目配置不同，请刷新后重试", 409);
      } catch (e: any) {
        for (const guard of guarded) await settleRevisionWork({ projectId, scriptId }, guard, "FAILED", { error: e.message });
        return res.status(e.status ?? 409).send({ code: "VIDEO_MODEL_UNAVAILABLE", message: e.message });
      }
      res.status(200).send(success(guarded.map(guard => ({ videoId: guard.videoId, trackId: guard.trackId }))));
      for (const [index, guard] of guarded.entries()) void runControlledVideo({ projectId, scriptId }, guard,
        controlledItems[index], { model: resolvedModel, mode, resolution, audio });
      return;
    }

    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }

    // 获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();

    // 为每个 track 预处理数据并插入数据库，返回任务列表
    const tasks = await Promise.all(
      (trackData as { uploadData: { id: number; sources: string }[]; trackId: number; prompt: string; duration: number }[]).map(async (track) => {
        const { uploadData, trackId, prompt, duration } = track;

        // 查询出图片数据
        const images = await Promise.all(
          uploadData.map(async (item) => {
            if (item.sources === "storyboard") {
              const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
              return { path: filePath?.filePath, sources: "storyBoard" };
            }
            if (item.sources === "assets") {
              const filePath = await u
                .db("o_assets")
                .where("o_assets.id", item.id)
                .leftJoin("o_image", "o_assets.imageId", "o_image.id")
                .select("o_image.filePath", "o_image.type")
                .first();
              return { path: filePath?.filePath, sources: filePath.type };
            }
          }),
        );

        const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
        const [videoId] = await u.db("o_video").insert({
          filePath: videoPath,
          time: Date.now(),
          state: "生成中",
          scriptId,
          projectId,
          videoTrackId: trackId,
        });

        return { videoId, videoPath, prompt, duration, images, trackId };
      }),
    );

    res.status(200).send(success(tasks.map((t) => ({ videoId: t.videoId, trackId: t.trackId }))));
    for (const { videoId, videoPath, prompt, duration, images } of tasks) {
      // 所有任务全部并发后台执行，完全不阻塞任何进程
      const base64 = await Promise.all(
        images.map(async (item) => {
          if (!item) return null;
          return { base64: await u.oss.getImageBase64(item.path), type: item.sources == "audio" ? "audio" : "image" };
        }),
      );
      const relatedObjects = { projectId, videoId, scriptId, type: "视频" };
      const aiVideo = u.Ai.Video(model!);
      aiVideo
        .run(
          {
            prompt,
            referenceList: base64.filter(Boolean) as ReferenceList[],
            mode: modeData.length > 0 ? modeData : mode,
            duration,
            aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
            resolution,
            audio,
          },
          {
            projectId,
            taskClass: "视频生成",
            describe: "根据提示词生成视频",
            relatedObjects: JSON.stringify(relatedObjects),
          },
        )
        .then(async () => await aiVideo.save(videoPath))
        .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功" }))
        .catch(async (error: any) => {
          await u
            .db("o_video")
            .where("id", videoId)
            .update({
              state: "生成失败",
              errorReason: u.error(error).message,
            });
        });
    }
  },
);

import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { admitRevisionWork } from "@/services/orchestrator/revisionWorkGuard";
import { runControlledVideo, runE001ControlledVideo } from "@/services/orchestrator/controlledVideoWorker";
import { reserveE001VideoGeneration } from "@/services/orchestrator/videoProduction";
import { videoProfileClassForProject } from "@/services/orchestrator/videoProductionProfile";
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
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
      }),
    ),
    prompt: z.string(),
    model: z.string().optional(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    const controlledPath = `/${projectId}/video/${uuidv4()}.mp4`;
    let profileClass;
    try { profileClass = await videoProfileClassForProject(projectId); }
    catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code ?? "VIDEO_PROFILE_COMPAT_UNSUPPORTED", message: e.message }); }
    if (profileClass === "MANAGED_V2_UNSUPPORTED")
      return res.status(409).send({ code: "VIDEO_PROFILE_COMPAT_UNSUPPORTED", message: "当前受控 Profile 未声明受支持的视频生产合同" });
    if (profileClass === "E001_ENABLED") {
      try {
        const reserved = await reserveE001VideoGeneration({ projectId, scriptId },
          [{ trackId, references: uploadData, videoPath: controlledPath, prompt, duration }],
          { model, mode, resolution, audio });
        const guard = reserved.guards[0];
        res.status(200).send(success(guard.videoId));
        void runE001ControlledVideo({ projectId, scriptId }, guard);
        return;
      } catch (e: any) {
        return res.status(e.status ?? 409).send({ code: e.code ?? "REVISION_RUNTIME_UNSAFE", message: e.message });
      }
    }
    const controlled = profileClass === "PRE_001E_CONTROLLED_COMPAT";
    const guarded = controlled ? await admitRevisionWork({ projectId, scriptId }, "VIDEO_GENERATE",
      [{ trackId, references: uploadData, videoPath: controlledPath }]).catch((e: any) => {
        res.status(e.status ?? 409).send({ code: e.code ?? "REVISION_RUNTIME_UNSAFE", message: e.message }); return undefined;
      }) : null;
    if (controlled && guarded === undefined) return;
    if (controlled && !guarded) return res.status(409).send({ code: "REVISION_RUNTIME_UNSAFE", message: "受控 Profile 已变化，请重试" });
    if (guarded) {
      const guard = guarded[0];
      let resolvedModel: string;
      try {
        resolvedModel = await requireModel(projectId, "video", model);
        if (model && resolvedModel !== model) throw new ModelConfigError("所选模型与当前项目配置不同，请刷新后重试", 409);
      } catch (e: any) {
        await settleRevisionWork({ projectId, scriptId }, guard, "FAILED", { error: e.message });
        return res.status(e.status ?? 409).send({ code: "VIDEO_MODEL_UNAVAILABLE", message: e.message });
      }
      res.status(200).send(success(guard.videoId));
      void runControlledVideo({ projectId, scriptId }, guard,
        { trackId, videoPath: controlledPath, uploadData, prompt, duration }, { model: resolvedModel, mode, resolution, audio });
      return;
    }
    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }
    //获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    //查询出图片数据
    const images = await Promise.all(
      uploadData.map(async (item: UploadItem) => {
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
    //把images里面的图片转成base64格式
    const base64 = await Promise.all(
      images.map(async (item) => {
        if (!item) return null;
        return { base64: await u.oss.getImageBase64(item.path), type: item.sources == "audio" ? "audio" : "image" };
      }),
    );
    //新增
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId,
      projectId,
      videoTrackId: trackId,
    });
    res.status(200).send(success(videoId));
    const relatedObjects = {
      projectId,
      videoId,
      scriptId,
      type: "视频",
    };
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
  },
);

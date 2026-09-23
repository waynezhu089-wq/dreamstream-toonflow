import { productionFields, productionSpec, isAdvertisement, writeAdvertisementStoryboards } from "@/services/storyboardProduction";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

const storyboardItemSchema = z.object({
  ...productionFields,
  videoDesc: z.string(),
  prompt: z.string().nullable(),
  track: z.string(),
  duration: z.number().positive(),
  associateAssetsIds: z.array(z.number()).nullable(),
  shouldGenerateImage: z.enum(["true", "false"]),
});

export default router.post(
  "/",
  validateFields({
    data: z.array(storyboardItemSchema).min(1).max(50),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    if (await isAdvertisement(req.body.projectId)) {
      try {
        const result = await writeAdvertisementStoryboards(req.body.projectId, req.body.scriptId, req.body.data, "replace");
        return res.status(200).send(success(result));
      } catch (e: any) { return res.status(e.status ?? 400).send({ code: e.code ?? "STORYBOARD_PRODUCTION_INVALID", message: e.message }); }
    }
    const { data, scriptId, projectId } = req.body as {
      data: z.infer<typeof storyboardItemSchema>[];
      scriptId: number;
      projectId: number;
    };

    const existingVideos = await u.db("o_video").where({ scriptId, projectId }).select("id").first();
    if (existingVideos) {
      return res.status(409).send(error("当前制作单元已有视频记录，禁止整套替换分镜，请先人工确认后处理"));
    }

    try {
      const result = await u.db.transaction(async (trx: any) => {
        const oldStoryboards = await trx("o_storyboard").where({ scriptId, projectId }).select("id", "flowId");
        const oldIds = oldStoryboards.map((i: any) => i.id).filter(Boolean);
        const oldFlowIds = oldStoryboards.map((i: any) => i.flowId).filter(Boolean);

        if (oldIds.length) {
          await trx("o_assets2Storyboard").whereIn("storyboardId", oldIds).delete();
          await trx("o_storyboard").whereIn("id", oldIds).delete();
        }
        if (oldFlowIds.length) {
          await trx("o_imageFlow").whereIn("id", oldFlowIds).delete();
        }

        await trx("o_videoTrack").where({ scriptId, projectId }).delete();

        const trackNames = [...new Set(data.map((item) => item.track || "未分组"))];
        const trackIdMap = new Map<string, number>();
        const baseTrackId = Date.now();

        for (let i = 0; i < trackNames.length; i++) {
          const track = trackNames[i];
          const trackId = baseTrackId + i;
          const duration = data
            .filter((item) => (item.track || "未分组") === track)
            .reduce((sum, item) => sum + Number(item.duration), 0);
          await trx("o_videoTrack").insert({
            id: trackId,
            scriptId,
            projectId,
            duration,
          });
          trackIdMap.set(track, trackId);
        }

        const created: any[] = [];
        for (let index = 0; index < data.length; index++) {
          const item = data[index];
          const track = item.track || "未分组";
          const [id] = await trx("o_storyboard").insert({
            prompt: item.prompt ?? "",
            duration: String(item.duration),
            state: "未生成",
            scriptId,
            projectId,
            track,
            trackId: trackIdMap.get(track),
            videoDesc: item.videoDesc,
            shouldGenerateImage: item.shouldGenerateImage === "true" ? 1 : 0,
            index,
            createTime: Date.now() + index,
          });

          const associateAssetsIds = item.associateAssetsIds ?? [];
          if (associateAssetsIds.length) {
            await trx("o_assets2Storyboard").insert(
              associateAssetsIds.map((assetId) => ({
                assetId,
                storyboardId: id,
              })),
            );
          }

          created.push({
            id,
            index,
            duration: Number(item.duration),
            prompt: item.prompt ?? "",
            associateAssetsIds,
            src: null,
            state: "未生成",
            videoDesc: item.videoDesc,
            shouldGenerateImage: item.shouldGenerateImage === "true" ? 1 : 0,
            trackId: trackIdMap.get(track),
            reason: "",
          });
        }

        return created;
      });

      return res.status(200).send(success(result));
    } catch (err) {
      console.error("[replaceStoryboard] error:", err);
      return res.status(500).send(error("整套替换分镜失败"));
    }
  },
);

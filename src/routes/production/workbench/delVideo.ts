import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { controlledTrackContext, assertTrackNotBusy } from "@/services/orchestrator/revisionWriteSafety";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
import { retireE001Video } from "@/services/orchestrator/videoProduction";
import { videoProfileClassForProject } from "@/services/orchestrator/videoProductionProfile";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    reason: z.string().max(1000).optional(),
  }),
  async (req, res) => {
    const { id, reason } = req.body;
    try {
      const video = await u.db("o_video").where({ id }).first();
      if (!video) return res.status(200).send(success({ message: "视频不存在" }));
      const profileClass = await videoProfileClassForProject(Number(video.projectId));
      if (profileClass === "MANAGED_V2_UNSUPPORTED")
        throw new ProfileError("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前受控 Profile 未声明受支持的视频生产合同", 409);
      if (profileClass === "E001_ENABLED") {
        const result = await retireE001Video(id, (req as any).user, reason || "Human retired candidate");
        return res.status(200).send(success(result));
      }
      await u.db.transaction(async trx => {
        const current = await trx("o_video").where({ id }).first();
        if (!current) return;
        const context = await controlledTrackContext(trx, current.videoTrackId!);
        if (context.controlled) await assertTrackNotBusy(trx, context, current.videoTrackId!);
        await trx("o_video").where({ id }).delete();
        await trx("o_videoTrack").where({ videoId: id }).update({ videoId: null });
      });
    } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);

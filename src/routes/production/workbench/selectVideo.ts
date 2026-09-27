import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { controlledTrackContext, assertTrackNotBusy, assertActiveManagedTrack } from "@/services/orchestrator/revisionWriteSafety";
import { assertCurrentPermission } from "@/services/orchestrator/revisionWorkGuard";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
import { currentRevisionEpoch } from "@/services/orchestrator/revisionBoundary";
import { guardedVideoIsCurrent } from "@/services/orchestrator/revisionMediaRead";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    trackId: z.number(),
    videoId: z.number(),
  }),
  async (req, res) => {
    const { trackId, videoId } = req.body;
    try {
      await u.db.transaction(async trx => {
        const context = await controlledTrackContext(trx, trackId);
        const video = await trx("o_video").where({ id: videoId }).first();
        if (context.controlled) {
          await assertTrackNotBusy(trx, context, trackId);
          await assertActiveManagedTrack(trx, context, context.track);
          await assertCurrentPermission(trx, context, context.epoch);
          if (!video || video.projectId !== context.projectId || video.scriptId !== context.scriptId ||
            video.videoTrackId !== trackId) throw new ProfileError("REVISION_VIDEO_NOT_CURRENT", "候选视频不属于当前轨道", 409);
        }
        if (video?.revisionWorkGuardId) {
          if (video.projectId !== context.projectId || video.scriptId !== context.scriptId ||
            video.videoTrackId !== trackId || !await guardedVideoIsCurrent(trx,
              { projectId: context.projectId, scriptId: context.scriptId }, video,
              context.controlled ? context.epoch : await currentRevisionEpoch(trx, context.projectId, context.scriptId)))
            throw new ProfileError("REVISION_VIDEO_NOT_CURRENT", "视频任务未在当前修订代次成功结算", 409);
        } else if (context.controlled && context.epoch > 0) {
          throw new ProfileError("REVISION_VIDEO_NOT_CURRENT", "历史视频不能作为当前修订的生产成果", 409);
        }
        await trx("o_videoTrack").where({ id: trackId }).update({ videoId });
      });
    } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
    res.status(200).send(success({ message: "视频选择成功" }));
  },
);

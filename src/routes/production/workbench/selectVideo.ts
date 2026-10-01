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
import { acceptE001Video } from "@/services/orchestrator/videoProduction";
import { videoProfileClassForProject } from "@/services/orchestrator/videoProductionProfile";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional(),
    scriptId: z.number().optional(),
    trackId: z.number(),
    videoId: z.number(),
    acceptanceId: z.string().uuid().optional(),
    reason: z.string().max(1000).nullable().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackId, videoId, acceptanceId, reason } = req.body;
    try {
      const track = await u.db("o_videoTrack").where({ id: trackId }).first("projectId", "scriptId");
      if (!track) throw new ProfileError("REVISION_WORK_SCOPE_INVALID", "轨道不存在", 404);
      const resolvedProjectId = Number(track.projectId), resolvedScriptId = Number(track.scriptId);
      if (projectId != null && Number(projectId) !== resolvedProjectId || scriptId != null && Number(scriptId) !== resolvedScriptId)
        throw new ProfileError("REVISION_WORK_SCOPE_INVALID", "Accept 制作单元与轨道不一致", 409);
      const profileClass = await videoProfileClassForProject(resolvedProjectId);
      if (profileClass === "MANAGED_V2_UNSUPPORTED")
        throw new ProfileError("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前受控 Profile 未声明受支持的视频生产合同", 409);
      if (profileClass === "E001_ENABLED") {
        if (!acceptanceId) throw new ProfileError("VIDEO_ACCEPTANCE_ID_CONFLICT", "001E Accept 必须提供 acceptanceId", 400);
        const result = await acceptE001Video({ projectId: resolvedProjectId, scriptId: resolvedScriptId,
          trackId, videoId, acceptanceId, reason }, (req as any).user);
        return res.status(200).send(success(result));
      }
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

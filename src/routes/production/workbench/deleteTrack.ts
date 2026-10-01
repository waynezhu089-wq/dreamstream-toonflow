import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { controlledTrackContext, assertTrackNotBusy } from "@/services/orchestrator/revisionWriteSafety";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    try {
      await u.db.transaction(async trx => {
        const context = await controlledTrackContext(trx, id);
        if (context.controlled) {
          await assertTrackNotBusy(trx, context, id);
          if (await trx("o_storyboard").where({ projectId: context.projectId, scriptId: context.scriptId, trackId: id }).first("id") ||
            await trx("o_video").where({ projectId: context.projectId, scriptId: context.scriptId, videoTrackId: id }).first("id") ||
            await trx("o_revisionWorkGuard").where({ projectId: context.projectId, scriptId: context.scriptId, trackId: id }).first("guardId"))
            throw new ProfileError("CONTROLLED_REVISION_REQUIRED", "有分镜或视频历史的受控轨道不可物理删除", 409);
        }
        await trx("o_videoTrack").where("id", id).delete();
        await trx("o_storyboard").where("trackId", id).update({ trackId: null });
      });
    } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
    res.status(200).send(success({ message: "视频段删除成功" }));
  },
);

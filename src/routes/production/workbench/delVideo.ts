import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { controlledTrackContext, assertTrackNotBusy } from "@/services/orchestrator/revisionWriteSafety";
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
        const video = await trx("o_video").where({ id }).first();
        if (!video) return;
        const context = await controlledTrackContext(trx, video.videoTrackId!);
        if (context.controlled) await assertTrackNotBusy(trx, context, video.videoTrackId!);
        await trx("o_video").where({ id }).delete();
        await trx("o_videoTrack").where({ videoId: id }).update({ videoId: null });
      });
    } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);

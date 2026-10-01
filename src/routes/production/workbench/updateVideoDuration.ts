import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { controlledTrackContext, assertTrackNotBusy, assertActiveManagedTrack } from "@/services/orchestrator/revisionWriteSafety";
import { assertVideoOperationAllowedInTransaction } from "@/services/orchestrator/videoProductionProfile";
const router = express.Router();
export default router.post(
    "/",
    validateFields({
        id: z.number(),
        duration: z.number().optional(),
    }),
    async (req, res) => {
        const { id, duration } = req.body;
        try {
          await u.db.transaction(async trx => {
            const context = await controlledTrackContext(trx, id);
            if (context.controlled) {
              await assertVideoOperationAllowedInTransaction(trx, "video.source.update", context);
              await assertTrackNotBusy(trx, context, id);
              await assertActiveManagedTrack(trx, context, context.track);
            }
            await trx("o_videoTrack").where({ id }).update({ duration });
          });
        } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
        res.status(200).send(success("更新成功"));
    },
);

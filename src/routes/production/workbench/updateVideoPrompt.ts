import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { controlledTrackContext, assertTrackNotBusy, assertActiveManagedTrack } from "@/services/orchestrator/revisionWriteSafety";
import { assertCurrentPermission } from "@/services/orchestrator/revisionWorkGuard";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    prompt: z.string().optional(),
    expectedRevisionEpoch: z.number().int().nonnegative().optional(),
  }),
  async (req, res) => {
    const { id, prompt, expectedRevisionEpoch } = req.body;
    try {
      await u.db.transaction(async trx => {
        const context = await controlledTrackContext(trx, id);
        if (context.controlled) {
          if (typeof prompt !== "string") throw new ProfileError("REVISION_WORK_SCOPE_INVALID", "当前提示词不能为空", 409);
          await assertTrackNotBusy(trx, context, id);
          await assertActiveManagedTrack(trx, context, context.track);
          if (context.epoch > 0 && expectedRevisionEpoch !== context.epoch)
            throw new ProfileError("REVISION_PREVIEW_STALE", "提示词更新需要当前修订代次", 409);
          await assertCurrentPermission(trx, context, context.epoch);
        }
        await trx("o_videoTrack").where({ id }).update(context.controlled ?
          { prompt, promptRevisionEpoch: context.epoch } : { prompt });
      });
    } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
    res.status(200).send(success("更新成功"));
  },
);

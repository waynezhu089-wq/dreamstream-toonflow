import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { assertDirectSemanticWriteAllowed } from "@/services/orchestrator/revisionWriteSafety";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { id, projectId } = req.body;
    try {
      await u.db.transaction(async trx => {
        const asset = await trx("o_assets").where({ id, projectId }).first();
        if (!asset) throw { status: 404, code: "ASSET_NOT_FOUND", message: "资源未找到" };
        const linked = await trx("o_assets2Storyboard").where({ assetId: id })
          .join("o_storyboard", "o_storyboard.id", "o_assets2Storyboard.storyboardId")
          .select("o_storyboard.projectId", "o_storyboard.scriptId");
        for (const item of linked) await assertDirectSemanticWriteAllowed(trx, item.projectId, item.scriptId);
        if (asset.flowId) await trx("o_imageFlow").where({ id: asset.flowId }).delete();
        await trx("o_assets").where({ id, projectId }).delete();
        await trx("o_assets2Storyboard").where({ assetId: id }).delete();
      });
    } catch (e: any) { return res.status(e.status ?? 409).send({ code: e.code, message: e.message }); }
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);

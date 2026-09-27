import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { acquireRevisionBoundary } from "@/services/orchestrator/revisionBoundary";
import { isControlledSemanticV2 } from "@/services/orchestrator/revisionWriteSafety";
const router = express.Router();

// 编辑剧本
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    content: z.string(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { id, name, content, assets } = req.body;
    try {
      await u.db.transaction(async trx => {
        const script = await trx("o_script").where({ id }).first("projectId");
        if (!script) return;
        const controlled = await isControlledSemanticV2(trx, script.projectId, id);
        if (controlled) await acquireRevisionBoundary(trx, script.projectId, id);
        await trx("o_script").where({ id }).update({ name, content });
        if (assets.length) {
          const assetsData = await trx("o_assets").whereIn("id", assets).select();
          if (controlled && assetsData.some(item => item.projectId !== script.projectId || item.scriptId != null && item.scriptId !== id))
            throw new Error("REVISION_WORK_SCOPE_INVALID");
          await trx("o_scriptAssets").where({ scriptId: id }).delete();
          if (assetsData.length) await trx("o_scriptAssets").insert(assetsData.map(item => ({ scriptId: id, assetId: item.id })));
        }
      });
    } catch (e: any) { return res.status(409).send({ code: e.code ?? "REVISION_WORK_SCOPE_INVALID", message: e.message }); }

    res.status(200).send(success({ message: "编辑剧本成功" }));
  },
);

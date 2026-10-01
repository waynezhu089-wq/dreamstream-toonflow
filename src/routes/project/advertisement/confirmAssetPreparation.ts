import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { STATE_KEY, readState } from "@/services/advertisementGate";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().int().positive(),
    confirmed: z.boolean(),
  }),
  async (req, res) => {
    const { projectId, scriptId, confirmed } = req.body;
    try {
      const current = await readState(projectId, scriptId);
      if (confirmed && !current.prepared) {
        const message = current.assetCount === 0
          ? "请先建立当前制作单元的广告 Asset Plan"
          : "仍有未准备完成的必需素材：" + current.incompleteAssets.map(item => item.name || item.assetKey).join("、");
        return res.status(400).send(error(message));
      }

      const now = Date.now();
      const existing = await u
        .db("o_agentWorkData")
        .where({ projectId, episodesId: current.scriptId, key: STATE_KEY })
        .first();

      const data = JSON.stringify({
        confirmed,
        confirmedAt: confirmed ? now : null,
      });

      if (existing?.id) {
        await u.db("o_agentWorkData").where("id", existing.id).update({
          data,
          updateTime: now,
        });
      } else {
        await u.db("o_agentWorkData").insert({
          id: now,
          projectId,
          episodesId: current.scriptId,
          key: STATE_KEY,
          data,
          createTime: now,
          updateTime: now,
        });
      }

      const next = await readState(projectId, current.scriptId);
      return res.status(200).send(success(next));
    } catch (e: any) {
      return res.status(400).send(error(e?.message || "更新广告工作流状态失败"));
    }
  },
);

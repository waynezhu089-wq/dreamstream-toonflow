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
    scriptId: z.number().int().positive().optional(),
    confirmed: z.boolean(),
  }),
  async (req, res) => {
    const { projectId, scriptId, confirmed } = req.body;
    try {
      const current = await readState(projectId, scriptId);
      if (confirmed) {
        if (current.assetCount === 0) {
          return res.status(400).send(error("请先建立并关联广告基础资产"));
        }
        if (current.incompleteAssets.length) {
          return res.status(400).send(
            error(
              "仍有未准备完成的资产：" +
                current.incompleteAssets.map((item: any) => item.name || String(item.id)).join("、"),
            ),
          );
        }
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

import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readState } from "@/services/advertisementGate";

const router = express.Router();
export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number().int().positive() }),
  async (req, res) => {
    try {
      return res.status(200).send(success(await readState(req.body.projectId, req.body.scriptId)));
    } catch (e: any) {
      return res.status(400).send(error(e?.message || "获取广告工作流状态失败"));
    }
  },
);

export { STATE_KEY, readState } from "@/services/advertisementGate";

import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { gateFailure, ProductionGateError } from "@/services/advertisementGate";
import { readProductionOperationAdmission } from "@/services/orchestrator/productionOperationGuard";
import { beginManualAttachAttempt, finishManualAttachAttempt } from "@/services/manualAttach";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    url: z.string(),
    flowId: z.number(),
    projectId: z.number().optional(),
    scriptId: z.number().optional(),
  }),
  async (req, res) => {
    try {
      const { id, url, flowId, projectId, scriptId } = req.body;
      const shot = await u.db("o_storyboard").where({ id }).first();
      if (!shot || !Number.isSafeInteger(shot.projectId) || !Number.isSafeInteger(shot.scriptId) ||
        projectId != null && projectId !== shot.projectId || scriptId != null && scriptId !== shot.scriptId) {
        throw new ProductionGateError("分镜不属于当前制作单元", "PRODUCTION_CONTEXT_INVALID", 400);
      }
      const scope = { projectId: Number(shot.projectId), scriptId: Number(shot.scriptId), storyboardId: id };
      const admission = await readProductionOperationAdmission("storyboard.image.attach", scope);
      if (!admission.allowed) throw new ProductionGateError(admission.reason ?? "当前生产工序未放行", admission.code, 409);
      if (!admission.enforced) {
        await u.db("o_storyboard").where({ id }).update({ filePath: u.replaceUrl(url), flowId,
          state: "已完成", shouldGenerateImage: url ? 1 : 0 });
        return res.status(200).send(success({ message: "更新分镜成功" }));
      }
      const attempt = await beginManualAttachAttempt(scope, flowId, url);
      const result = await finishManualAttachAttempt(attempt.attemptId);
      if (result.status !== "SUCCEEDED") throw new ProductionGateError("图片来源或生产控制已变化，旧图已保留", result.staleCode ?? "PRODUCTION_SOURCE_CHANGED", 409);
      return res.status(200).send(success({ message: "更新分镜成功", attemptId: attempt.attemptId, status: "SUCCEEDED" }));
    } catch (error) {
      const failure = gateFailure(error);
      return res.status(failure.status).send({ code: failure.status, message: failure.message, data: failure });
    }
  },
);

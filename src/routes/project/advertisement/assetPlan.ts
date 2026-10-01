import express from "express";
import { ZodError } from "zod";
import { success } from "@/lib/responseFormat";
import { AssetPlanError, readAssetPlan, saveAssetPlan, bindAssetPlanItem, unbindAssetPlanItem } from "@/services/advertisementAssetPlan";

const router = express.Router();
for (const [path, action] of Object.entries({ read: readAssetPlan, save: saveAssetPlan, bind: bindAssetPlanItem, unbind: unbindAssetPlanItem })) {
  router.post(`/${path}`, async (req, res) => {
    try {
      return res.status(200).send(success(await action(req.body)));
    } catch (error) {
      const status = error instanceof ZodError ? 400 : error instanceof AssetPlanError ? error.status : 500;
      const reason = error instanceof ZodError ? "ASSET_PLAN_INVALID_REQUEST" : error instanceof AssetPlanError ? error.code : "ASSET_PLAN_STORAGE_ERROR";
      const message = error instanceof ZodError ? "Asset Plan 参数不合法" : error instanceof AssetPlanError ? error.message : "Asset Plan 操作失败，请稍后重试";
      return res.status(status).send({ code: status, message, data: { reason } });
    }
  });
}
export default router;

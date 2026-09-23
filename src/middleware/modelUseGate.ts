import { isAdvertisement } from "@/services/storyboardProduction";
import type { RequestHandler } from "express";
import { requireModel, ModelConfigError, type Slot } from "@/services/modelPreset";
const entries: Record<string, Slot> = {
  "/api/assetsgenerate/generateassets": "image",
  "/api/assetsgenerate/batchgenerateimageassets": "image",
  "/api/production/editimage/generateflowimage": "image",
  "/api/production/assets/batchgenerateassetsimage": "image",
  "/api/production/storyboard/batchgenerateimage": "image",
  "/api/production/workbench/generatevideo": "video",
  "/api/production/workbench/batchgeneratevideo": "video",
};
export const modelUseGate: RequestHandler = async (req, res, next) => {
  const slot = entries[req.path.toLowerCase().replace(/\/+$/, "")];
  if (!slot) return next();
  try {
    // Advertisement dispatch checks models per item; real direct output needs none.
    if (req.path.toLowerCase().replace(/\/+$/, "") === "/api/production/storyboard/batchgenerateimage" && await isAdvertisement(Number(req.body.projectId))) return next();
    const resolved = await requireModel(Number(req.body.projectId), slot, req.body.model);
    if (req.body.model && resolved !== req.body.model) throw new ModelConfigError("所选模型与当前项目配置不同，请先在本项目模型配置中保存或刷新后重试", 409);
    req.body.model = resolved;
    next();
  } catch (e) {
    const status = e instanceof ModelConfigError ? e.status : 503;
    res.status(status).send({ code: status, message: e instanceof ModelConfigError ? e.message : "暂时无法检查模型配置，请稍后重试" });
  }
};

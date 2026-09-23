import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { listConfiguration, savePreset, setDefault, patchProject, resolveModels, requireModel, ModelConfigError } from "@/services/modelPreset";
const router = express.Router();
const run = (fn: (body: any) => Promise<any>): express.RequestHandler => async (req, res) => {
  try { res.send(success(await fn(req.body))); }
  catch (e) { const status = e instanceof ModelConfigError ? e.status : e instanceof z.ZodError ? 400 : 500;
    res.status(status).send({ code: status, message: e instanceof Error ? e.message : "模型配置失败" }); }
};
router.post("/list", run(listConfiguration));
router.post("/save", run(savePreset));
router.post("/default", run(setDefault));
router.post("/project", run(patchProject));
router.post("/resolve", run(body => resolveModels(z.number().int().positive().parse(body.projectId))));
router.post("/check", run(async body => ({ model: await requireModel(z.number().int().positive().parse(body.projectId), z.enum(["text", "image", "video", "tts"]).parse(body.slot)) })));
export default router;

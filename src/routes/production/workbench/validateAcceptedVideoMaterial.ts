import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { validateAcceptedVideoMaterial } from "@/services/orchestrator/videoProduction";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number().int().positive(),
  scriptId: z.number().int().positive(),
  items: z.array(z.object({
    trackId: z.number().int().positive(),
    videoId: z.number().int().positive(),
    acceptedSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedOutputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(200),
}), async (req, res) => {
  try { res.status(200).send(success(await validateAcceptedVideoMaterial(req.body))); }
  catch (e: any) { res.status(e.status ?? 409).send({ code: e.code ?? "VIDEO_EDITOR_MATERIAL_STALE", message: e.message }); }
});

import { productionFields, productionSpec, isAdvertisement, writeAdvertisementStoryboards } from "@/services/storyboardProduction";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
interface Storyboard {
  id: number;
  track: string;
  src: string | null;
  associateAssetsIds: number[];
  duration: number;
  state: string;
}
export default router.post(
  "/",
  validateFields({
  ...productionFields,
    prompt: z.string(),
    duration: z.number(),
    state: z.string(),
    videoDesc: z.string(),
    shouldGenerateImage: z.number(),
    src: z.string().nullable(),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    if (await isAdvertisement(req.body.projectId)) {
      try {
        const result = await writeAdvertisementStoryboards(req.body.projectId, req.body.scriptId, [req.body], "add");
        return res.status(200).send(success(result[0]));
      } catch (e: any) { return res.status(e.status ?? 400).send({ code: e.code ?? "STORYBOARD_PRODUCTION_INVALID", message: e.message }); }
    }
    const { prompt, duration, state, src, scriptId, projectId, videoDesc, shouldGenerateImage } = req.body;
    const trackId = Date.now()
    await u.db("o_videoTrack").insert({
      id: trackId,
      scriptId: scriptId,
      projectId,
    });
    const [id] = await u.db("o_storyboard").insert({
      prompt,
      duration,
      state,
      filePath: u.replaceUrl(src),
      trackId,
      videoDesc,
      shouldGenerateImage: src ? 1 : 0,
      scriptId: scriptId,
      projectId: projectId,
    });
    return res.status(200).send(success({ id }));
  },
);

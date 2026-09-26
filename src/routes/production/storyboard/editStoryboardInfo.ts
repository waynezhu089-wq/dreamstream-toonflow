import { productionFields, productionSpec, isAdvertisement, writeAdvertisementStoryboards } from "@/services/storyboardProduction";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { id } from "zod/locales";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ...productionFields,
    projectId: z.number().optional(),
    scriptId: z.number().optional(),
    id: z.number(),
    prompt: z.string(),
    videoDesc: z.string(),
  }),
  async (req, res) => {
    const { id, prompt, videoDesc } = req.body;
    const row = await u.db("o_storyboard").where({ id }).first();
    if (row && await isAdvertisement(row.projectId!)) {
      if ((req.body.projectId !== undefined && req.body.projectId !== row.projectId) || (req.body.scriptId !== undefined && req.body.scriptId !== row.scriptId)) return res.status(400).send({message:"分镜不属于当前项目和制作单元"});
      try { return res.status(200).send(success((await writeAdvertisementStoryboards(row.projectId!, row.scriptId!, [req.body], "edit"))[0])); }
      catch(e: any) { return res.status(e.status ?? 400).send({code:e.code ?? "STORYBOARD_PRODUCTION_INVALID",message:e.message}); }
    }
    await u.db("o_storyboard").where({ id }).update({
      prompt,
      videoDesc,
    });
    res.status(200).send(success({ message: "更新提示词成功" }));
  },
);

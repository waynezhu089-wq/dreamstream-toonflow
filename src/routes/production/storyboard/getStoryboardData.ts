import { productionSpec } from "@/services/storyboardProduction";
import { readImageProvenance } from "@/services/productionAttempt";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number().optional(),
    scriptId: z.number(),
    page: z.number(),
    limit: z.number(),
    name: z.string().optional().nullable(),
    historyOnly: z.boolean().optional(),
  }),
  async (req, res) => {
    const { scriptId, page, limit, name, historyOnly = false } = req.body;
    const script = await u.db("o_script").where({id:scriptId}).first();
    if (!script || (req.body.projectId !== undefined && req.body.projectId !== script.projectId)) return res.status(400).send({message:"制作单元不属于当前项目"});
    const projectId = script.projectId;
    const offset = (page - 1) * limit;

    const storyboardData = await u
      .db("o_storyboard")
      .where({ scriptId, projectId })
      .modify((qb) => {
        if (historyOnly) qb.whereNotNull("retiredAt");
        else qb.whereNull("retiredAt");
        if (name) {
          qb.andWhere("title", "like", `%${name}%`);
        }
      })
      .orderBy(historyOnly ? "retiredAt" : "index", historyOnly ? "desc" : "asc")
      .orderBy("id", historyOnly ? "desc" : "asc")
      .offset(offset)
      .limit(limit);
    const imageProvenance = historyOnly ? new Map() : await readImageProvenance(Number(projectId), scriptId, storyboardData);
    const data = await Promise.all(
      storyboardData.map(async (i: any) => {
        return {
          ...productionSpec(i),
          imageProvenance: imageProvenance.get(i.id!),
          id: i.id,
          prompt: i.prompt,
          imagePrompt: i.imagePrompt ?? null,
          state: i.state,
          src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath!) : "",
        };
      }),
    );
    const totalQuery = (await u
      .db("o_storyboard")
      .where({ scriptId, projectId })
      .modify((qb) => {
        if (historyOnly) qb.whereNotNull("retiredAt");
        else qb.whereNull("retiredAt");
        if (name) {
          qb.andWhere("title", "like", `%${name}%`);
        }
      })
      .count("* as total")
      .first()) as any;

    res.status(200).send(success({ data: data, total: totalQuery?.total }));
  },
);

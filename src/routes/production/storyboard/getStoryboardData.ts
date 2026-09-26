import { productionSpec } from "@/services/storyboardProduction";
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
  }),
  async (req, res) => {
    const { scriptId, page, limit, name } = req.body;
    const script = await u.db("o_script").where({id:scriptId}).first();
    if (!script || (req.body.projectId !== undefined && req.body.projectId !== script.projectId)) return res.status(400).send({message:"制作单元不属于当前项目"});
    const projectId = script.projectId;
    const offset = (page - 1) * limit;

    const storyboardData = await u
      .db("o_storyboard")
      .where({ scriptId, projectId })
      .modify((qb) => {
        if (name) {
          qb.andWhere("title", "like", `%${name}%`);
        }
      })
      .offset(offset)
      .limit(limit);
    const data = await Promise.all(
      storyboardData.map(async (i: any) => {
        return {
          ...productionSpec(i),
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
        if (name) {
          qb.andWhere("title", "like", `%${name}%`);
        }
      })
      .count("* as total")
      .first()) as any;

    res.status(200).send(success({ data: data, total: totalQuery?.total }));
  },
);

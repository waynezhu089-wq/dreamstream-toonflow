import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isAdvertisement, patchProject, resolveModels } from "@/services/modelPreset";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    projectType: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
  }),
  async (req, res) => {
    const { id, name, intro, type, artStyle, videoRatio, directorManual, imageModel, videoModel, imageQuality, projectType, mode } = req.body;

    const ad = isAdvertisement({ projectType, type });
    const before = ad ? await resolveModels(id) : null;
    await u.db("o_project").where("id", id).update({
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      ...(ad ? {} : { imageModel, videoModel }),
      imageQuality,
      projectType,
      mode,
    });

    if (before) {
      const slots: Record<string, string | null> = {};
      if ((before.models.image ?? "") !== imageModel) slots.image = imageModel || null;
      if ((before.models.video ?? "") !== videoModel) slots.video = videoModel || null;
      if (Object.keys(slots).length) await patchProject({ projectId: id, slots });
    }
    res.status(200).send(success({ message: "编辑项目成功" }));
  },
);

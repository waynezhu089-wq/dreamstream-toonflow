import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isAdvertisement, resolveModels } from "@/services/modelPreset";
const router = express.Router();

// 获取项目
export default router.post("/", async (req, res) => {
  const data = await u.db("o_project").select("*");
  const result = await Promise.all(data.map(async p => {
    if (!isAdvertisement(p)) return p;
    const { models } = await resolveModels(p.id!);
    return { ...p, imageModel: models.image ?? "", videoModel: models.video ?? "" };
  }));
  res.status(200).send(success(result));
});

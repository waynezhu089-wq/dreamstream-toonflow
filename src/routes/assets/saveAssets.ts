import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { recordAssetUpload } from "@/services/assetUploadSource";
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    prompt: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, type, prompt, projectId, imageId } = req.body;
    if (base64) {
      const asset = await u.db("o_assets").where({ id, projectId }).first();
      if (!asset) return res.status(400).send({ message: "资产不属于当前项目" });
      //自定义上传选择的图片
      const matches = base64.match(/^data:image\/\w+;base64,(.+)$/);
      const realBase64 = matches ? matches[1] : base64;
      // 生成新的图片路径
      const savePath = `/${projectId}/${type}/${uuidv4()}.png`;
      // 写入文件
      await u.oss.writeFile(savePath, Buffer.from(realBase64, "base64"));
      await u.db.transaction(async (trx) => {
        const [uploadedImageId] = await trx("o_image").insert({
          assetsId: id, filePath: savePath, type, state: "已完成",
        });
        await trx("o_assets").where({ id, projectId }).update({
          prompt: prompt ?? "", imageId: uploadedImageId,
        });
        await recordAssetUpload(trx, { projectId, assetId: id, imageId: uploadedImageId, filePath: savePath });
      });
    } else {
      await u
        .db("o_assets")
        .where("id", id)
        .update({
          prompt: prompt ?? "",
          imageId: imageId,
        });
    }
    res.status(200).send(success({ message: "保存资产图片成功" }));
  },
);

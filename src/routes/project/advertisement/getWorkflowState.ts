import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();
const STATE_KEY = "advertisement:asset-preparation";

async function readState(projectId: number) {
  const project = await u.db("o_project").where("id", projectId).first();
  if (!project) throw new Error("项目不存在");
  if (project.projectType !== "general_video" || project.type !== "advertisement") {
    throw new Error("当前项目不是广告视频项目");
  }

  const script = await u.db("o_script").where("projectId", projectId).orderBy("createTime", "asc").first();
  if (!script?.id) throw new Error("广告制作单元不存在");

  const assets = await u
    .db("o_scriptAssets")
    .join("o_assets", "o_scriptAssets.assetId", "o_assets.id")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .where("o_scriptAssets.scriptId", script.id)
    .whereNull("o_assets.assetsId")
    .select(
      "o_assets.id",
      "o_assets.name",
      "o_assets.type",
      "o_assets.imageId",
      "o_image.state as imageState",
      "o_image.filePath as filePath",
    );

  const incompleteAssets = assets
    .filter((item: any) => !item.imageId || item.imageState !== "已完成" || !item.filePath)
    .map((item: any) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      state: item.imageState ?? "未生成",
    }));

  const stateRow = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: script.id, key: STATE_KEY })
    .orderBy("updateTime", "desc")
    .first();

  let confirmed = false;
  if (stateRow?.data) {
    try {
      confirmed = Boolean(JSON.parse(stateRow.data).confirmed);
    } catch {}
  }

  return {
    projectId,
    scriptId: script.id,
    assetCount: assets.length,
    readyAssetCount: assets.length - incompleteAssets.length,
    incompleteAssets,
    confirmed,
    ready: confirmed && assets.length > 0 && incompleteAssets.length === 0,
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    try {
      const data = await readState(req.body.projectId);
      return res.status(200).send(success(data));
    } catch (e: any) {
      return res.status(400).send(error(e?.message || "获取广告工作流状态失败"));
    }
  },
);

export { STATE_KEY, readState };

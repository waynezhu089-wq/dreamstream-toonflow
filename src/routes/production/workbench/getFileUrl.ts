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
        includeRetired: z.boolean().optional(),
        projectId: z.number().optional(),
        scriptId: z.number().optional(),
        items: z.array(z.object({
            id: z.number(),
            sources: z.string()
        }))
    }),
    async (req, res) => {
        const { items } = req.body;
        if (req.body.includeRetired && (!Number.isSafeInteger(req.body.projectId) || !Number.isSafeInteger(req.body.scriptId)))
            return res.status(400).send({ code: "REVISION_SCOPE_INVALID", message: "读取历史素材须指定制作单元" });
        const result: Record<string, string> = {};
        const storyboardIds = items.filter((item: any) => item.sources == "storyboard").map((item: any) => item.id)
        const totalFilePaths = []
        if (storyboardIds.length) {
            const query = u.db("o_storyboard").whereIn("id", storyboardIds);
            if (!req.body.includeRetired) query.whereNull("retiredAt");
            else query.where({ projectId: req.body.projectId, scriptId: req.body.scriptId });
            const storyBoardPaths = await query.select("id", "filePath");
            totalFilePaths.push(...storyBoardPaths.map(i => ({ id: i.id, filePath: i.filePath, sources: "storyboard" })))
        }
        const assetsIds = items.filter((item: any) => item.sources == "assets").map((item: any) => item.id)
        if (assetsIds.length) {
            const assetQuery = u.db("o_assets").leftJoin("o_image", "o_image.id", "o_assets.imageId").whereIn("o_assets.id", assetsIds);
            if (req.body.includeRetired) assetQuery.where("o_assets.projectId", req.body.projectId)
                .whereIn("o_assets.id", u.db("o_scriptAssets").where("scriptId", req.body.scriptId).select("assetId"));
            const assetsPaths = await assetQuery.select("o_assets.id", "o_image.filePath");
            totalFilePaths.push(...assetsPaths.map(i => ({ id: i.id, filePath: i.filePath, sources: "assets" })))
        }

        await Promise.all(
            totalFilePaths.map(async (item: { id: string, filePath: string, sources: string }) => {
                result[`${item.id}:${item.sources}`] = item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "";
            }))

        res.status(200).send(success({ data: result }));
    },
);

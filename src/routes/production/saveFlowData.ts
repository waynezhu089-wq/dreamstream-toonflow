import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
import { flowDataSchema } from "@/agents/productionAgent/tools";
import { acquireRevisionBoundary } from "@/services/orchestrator/revisionBoundary";
import { isControlledSemanticV2 } from "@/services/orchestrator/revisionWriteSafety";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
import { productionSpec } from "@/services/storyboardProduction";

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any(),
  }),
  async (req, res) => {
    const {
      data,
      projectId,
      episodesId,
    }: {
      data: z.infer<typeof flowDataSchema>;
      projectId: number;
      episodesId: number;
    } = req.body;
    try {
      const controlled = await u.db.transaction(async trx => {
        if (!await isControlledSemanticV2(trx, projectId, episodesId)) return false;
        await acquireRevisionBoundary(trx, projectId, episodesId);
        if (!await isControlledSemanticV2(trx, projectId, episodesId)) return false;
        if (!data || typeof data !== "object" || data.storyboard !== undefined && !Array.isArray(data.storyboard))
          throw new ProfileError("CONTROLLED_REVISION_REQUIRED", "受控工作区分镜数据格式不合法", 409);
        const rows = await trx("o_storyboard").where({ projectId, scriptId: episodesId }).whereNull("retiredAt")
          .orderBy("index", "asc").orderBy("id", "asc");
        const requested = Array.isArray(data.storyboard) ? data.storyboard : [];
        if (requested.length > 200) throw new ProfileError("CONTROLLED_REVISION_REQUIRED", "受控分镜工作区超过上限", 409);
        if (requested.length && (requested.length !== rows.length || requested.some((item, i) =>
          Number(item.id) !== Number(rows[i].id) || item.index !== rows[i].index))) {
          throw new ProfileError("CONTROLLED_REVISION_REQUIRED", "分镜重排须通过受控修订确认", 409);
        }
        if (requested.length) {
          const links = await trx("o_assets2Storyboard").whereIn("storyboardId", rows.map(row => row.id))
            .select("storyboardId", "assetId");
          const byShot = new Map<number, number[]>();
          for (const link of links) byShot.set(Number(link.storyboardId), [...(byShot.get(Number(link.storyboardId)) ?? []), Number(link.assetId)]);
          const sameIds = (left: number[], right: number[]) => JSON.stringify([...left].sort((a, b) => a - b)) === JSON.stringify([...right].sort((a, b) => a - b));
          for (const [i, item] of requested.entries()) {
            const row = rows[i], spec = productionSpec(row);
            const expected: Record<string, unknown> = { prompt: row.prompt, videoDesc: row.videoDesc,
              track: row.track, duration: Number(row.duration), productionMode: spec.productionMode,
              primaryAssetId: spec.primaryAssetId };
            if (Object.entries(expected).some(([key, value]) => Object.hasOwn(item, key) && (item as any)[key] !== value) ||
              Object.hasOwn(item, "associateAssetsIds") && !sameIds(item.associateAssetsIds ?? [], byShot.get(Number(row.id)) ?? []) ||
              Object.hasOwn(item, "referenceAssetIds") && !sameIds(item.referenceAssetIds ?? [], spec.referenceAssetIds) ||
              Object.hasOwn(item, "referenceAssetGroupIds") && JSON.stringify([...(item.referenceAssetGroupIds ?? [])].sort()) !== JSON.stringify([...spec.referenceAssetGroupIds].sort()))
              throw new ProfileError("CONTROLLED_REVISION_REQUIRED", "语义修改须通过受控修订确认", 409);
          }
        }
        // A saved workspace cannot become an alternative source of semantic
        // truth. getFlowData rehydrates active storyboard rows from SQLite.
        const layout = { ...data, storyboard: [] };
        const key = { projectId, episodesId, key: "productionAgent" };
        const existing = await trx("o_agentWorkData").where(key).first("id");
        if (existing) await trx("o_agentWorkData").where(key).update({ data: JSON.stringify(layout) });
        else await trx("o_agentWorkData").insert({ ...key, data: JSON.stringify(layout) });
        return true;
      });
      if (controlled) return res.status(200).send(success());
    } catch (e: any) {
      return res.status(e.status ?? 409).send({ code: e.code ?? "REVISION_RUNTIME_UNSAFE", message: e.message });
    }
    const sqlData = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .andWhere("key", "productionAgent")
      .first();
    if (data.storyboard && data.storyboard.length) {
      const filterDatas = data?.storyboard.filter((i) => !i.id);
      if (!filterDatas.length) {
        try {
          await Promise.all(
            data.storyboard
              .filter((i) => i.id)
              .map(async (i, index) => {
                await u.db("o_storyboard").where("id", i.id).update({
                  index: index,
                });
              }),
          );
        } catch (error) {
          console.error("更新分镜排序失败", error);
        }
      }
    }

    if (!sqlData) {
      await u.db("o_agentWorkData").insert({
        projectId,
        episodesId,
        key: "productionAgent",
        data: JSON.stringify(data),
      });
    } else {
      await u
        .db("o_agentWorkData")
        .where("projectId", String(projectId))
        .where("key", "productionAgent")
        .andWhere("episodesId", String(episodesId))
        .update({
          data: JSON.stringify(data),
        });
    }
    return res.status(200).send(success());
  },
);

import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { revisionMediaProjection } from "@/services/orchestrator/revisionMediaRead";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    historyOnly: z.boolean().optional(),
    historyOffset: z.number().int().nonnegative().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, historyOnly = false, historyOffset = 0 } = req.body;
    const query = u.db("o_storyboard").where({ scriptId, projectId });
    if (historyOnly) query.whereNotNull("retiredAt").orderBy("retiredAt", "desc").orderBy("id", "desc").limit(100).offset(historyOffset);
    else query.whereNull("retiredAt").orderBy("index", "asc");
    const storyboardList = await query;
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      storyboardList.map((s) => s.trackId),
    );
    const media = await revisionMediaProjection(projectId, scriptId, videoList);
    res.status(200).send(
      success(
        await Promise.all(
          videoList.map(async (s) => ({
            ...s,
            revisionStatus: media.status(s),
            src: s.filePath ? await u.oss.getSmallImageUrl(s.filePath) : "",
          })),
        ),
      ),
    );
  },
);

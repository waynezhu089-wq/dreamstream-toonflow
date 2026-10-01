import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { setShotCapabilityOverride } from "@/services/shotCapabilityOverride";

const router = express.Router();
const schema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
  storyboardId: z.number().int().positive(), capabilityId: z.string().min(1).max(180).nullable() }).strict();

export default router.post("/", async (req, res) => {
  const input = schema.safeParse(req.body);
  if (!input.success) return res.status(400).send({ code: "SHOT_CAPABILITY_INVALID", message: "镜头 Capability 请求不合法" });
  try { return res.send(success(await setShotCapabilityOverride(input.data, (req as any).user?.id))); }
  catch (error: any) { return res.status(error.status ?? 500).send({ code: error.code ?? "SHOT_CAPABILITY_FAILED",
    message: error.message ?? "保存镜头 Capability 失败" }); }
});

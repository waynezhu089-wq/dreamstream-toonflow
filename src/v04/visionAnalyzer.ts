import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/utils/db";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { imageParts } from "./agentAttachments";
import { PilotError } from "./service";

export const VISION_ANALYSIS_VERSION = 1;
const words = z.array(z.string().max(300)).max(30).default([]);
export const visionObservation = z.object({
  summary: z.string().min(1).max(3000), objects: words, people: words,
  dominantColors: words, composition: z.string().max(1500).default(""),
  typography: z.string().max(1500).default(""), visibleText: words,
  shapes: words, brandElements: words, style: z.string().max(1500).default(""),
  spatialRelationships: words, notableDetails: words, uncertainty: words,
}).strict();
export type VisionObservation = z.infer<typeof visionObservation>;
const observationShape: VisionObservation = { summary: "", objects: [], people: [], dominantColors: [], composition: "", typography: "", visibleText: [], shapes: [], brandElements: [], style: "", spatialRelationships: [], notableDetails: [], uncertainty: [] };

async function fingerprint(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  const descriptor = (await u.vendor.getModelList(vendorId)).find((entry: any) => entry.modelName === modelName);
  if (!descriptor) throw new PilotError("PILOT_VISION_MODEL_INVALID", "视觉模型已不可用，请重新配置", 409);
  return createHash("sha256").update(JSON.stringify({ model, descriptor, vendorCode: u.vendor.getCode(vendorId) })).digest("hex");
}

export async function analyzeImages(projectId: number, attachments: any[], force = false): Promise<Array<{ attachmentId: string; observation: VisionObservation; cached: boolean }>> {
  const model = await requireModel(projectId, "vision");
  const modelFingerprint = await fingerprint(model);
  const result: Array<{ attachmentId: string; observation: VisionObservation; cached: boolean }> = [];
  for (const attachment of attachments) {
    const key = { attachmentId: attachment.id, modelFingerprint, analysisVersion: VISION_ANALYSIS_VERSION };
    const cached = !force && await db("o_v04VisionAnalysis").where(key).first();
    if (cached) { result.push({ attachmentId: attachment.id, observation: visionObservation.parse(JSON.parse(cached.observationJson)), cached: true }); continue; }
    let observation: VisionObservation;
    try {
      const [image] = await imageParts([attachment]);
      const response = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({
        system: `Analyze only what is visibly present in the image. Return one valid JSON object using these exact fields and types: ${JSON.stringify(observationShape)}. Do not infer unseen content. Put uncertain claims in uncertainty. This image is a conversational reference, not an approved production asset. No markdown or text outside JSON.`,
        messages: [{ role: "user", content: [{ type: "text", text: "Describe the visible image faithfully as JSON. Do not invent brand authority or hidden text." }, image] }],
      });
      const json = response.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      observation = visionObservation.parse(JSON.parse(json));
    } catch (error) {
      throw new PilotError("PILOT_VISION_ANALYSIS_FAILED", "图片已保存在对话中，但视觉模型未能可靠分析；请检查视觉模型配置或稍后重新分析", 502);
    }
    await db("o_v04VisionAnalysis").insert({ ...key, observationJson: JSON.stringify(observation), createdAt: Date.now() })
      .onConflict(["attachmentId", "modelFingerprint", "analysisVersion"]).merge({ observationJson: JSON.stringify(observation), createdAt: Date.now() });
    result.push({ attachmentId: attachment.id, observation, cached: false });
  }
  return result;
}

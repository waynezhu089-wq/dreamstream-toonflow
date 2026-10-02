import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/utils/db";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { getAgentAttachmentBytes } from "./agentAttachments";
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
const observationShape: VisionObservation = { summary: "Visible image summary", objects: [], people: [], dominantColors: [], composition: "", typography: "", visibleText: [], shapes: [], brandElements: [], style: "", spatialRelationships: [], notableDetails: [], uncertainty: [] };

type VisionFailureCode = "PILOT_VISION_PROVIDER_FAILED" | "PILOT_VISION_INPUT_UNSUPPORTED" | "PILOT_VISION_SCHEMA_FAILED";
export class VisionFailure extends PilotError {
  constructor(code: VisionFailureCode, message: string, public readonly errorId: string) { super(code, message, 502); }
}

function errorChain(error: unknown): Array<Record<string, any>> {
  const chain: Array<Record<string, any>> = [];
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  while (queue.length && chain.length < 6) {
    const current: any = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(-2));
  }
  return chain;
}

function sanitize(message: unknown): string {
  return String(message ?? "")
    .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, "[image data]")
    .replace(/https?:\/\/[^\s"']+/gi, "[url]")
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|authorization|cookie|token|secret)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9+/=]{120,}/g, "[long data]")
    .slice(0, 500);
}

function visionFailure(error: unknown, model: string, attachmentId: string, forcedCode?: VisionFailureCode): VisionFailure {
  const chain = errorChain(error);
  const description = chain.map(item => `${item.name ?? ""} ${item.message ?? ""} ${item.functionality ?? ""}`).join(" ");
  const imageRejected = /(?:image|vision|multimodal|image_url|图片|图像).{0,80}(?:not supported|unsupported|does not support|not allowed|invalid input|不支持|不接受|无法处理)|(?:not supported|unsupported|does not support|不支持).{0,80}(?:image|vision|multimodal|image_url|图片|图像)/i.test(description);
  const status = chain.map(item => item.statusCode ?? item.status ?? item.response?.status).find(value => Number.isInteger(Number(value))) ?? null;
  const providerFailed = chain.some(item => Number.isInteger(Number(item.statusCode ?? item.status ?? item.response?.status)) || /^(APICallError|AI_APICallError|FetchError|NetworkError|TimeoutError)$/i.test(String(item.name ?? "")));
  const schemaFailed = chain.some(item => /^(NoObjectGeneratedError|AI_NoObjectGeneratedError|ZodError|TypeValidationError|JSONParseError|AI_TypeValidationError|AI_JSONParseError)$/i.test(String(item.name ?? "")));
  const code: VisionFailureCode = forcedCode ?? (imageRejected ? "PILOT_VISION_INPUT_UNSUPPORTED" : providerFailed ? "PILOT_VISION_PROVIDER_FAILED" : schemaFailed ? "PILOT_VISION_SCHEMA_FAILED" : "PILOT_VISION_PROVIDER_FAILED");
  const message = code === "PILOT_VISION_INPUT_UNSUPPORTED" ? "当前视觉模型拒绝图片输入，请选择支持图片输入的模型。" : code === "PILOT_VISION_SCHEMA_FAILED" ? "视觉模型已返回内容，但结构化分析失败，可以重试。" : "视觉模型调用失败，请检查供应商配置。";
  const errorId = randomUUID();
  const [providerId, modelName] = model.split(/:(.+)/);
  console.error("[V04 Vision][StructuredOutputFailure]", {
    errorId, code, providerId, modelName, attachmentId, status,
    errorName: sanitize(chain[0]?.name), message: sanitize(chain[0]?.message),
    causeName: sanitize(chain[1]?.name), causeMessage: sanitize(chain[1]?.message),
  });
  return new VisionFailure(code, message, errorId);
}

async function fingerprint(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  const descriptor = (await u.vendor.getModelList(vendorId)).find((entry: any) => entry.modelName === modelName);
  if (!descriptor) throw new PilotError("PILOT_VISION_MODEL_INVALID", "视觉模型已不可用，请重新配置", 409);
  return createHash("sha256").update(JSON.stringify({ model, descriptor, vendorCode: u.vendor.getCode(vendorId) })).digest("hex");
}

export async function analyzeImages(projectId: number, attachments: any[], force = false): Promise<Array<{ attachmentId: string; observation: VisionObservation; cached: boolean }>> {
  const model = await requireModel(projectId, "vision");
  let modelFingerprint: string;
  try { modelFingerprint = await fingerprint(model); }
  catch (error) {
    if (error instanceof PilotError && error.code === "PILOT_VISION_MODEL_INVALID") throw error;
    throw visionFailure(error, model, attachments[0]?.id ?? "none");
  }
  const result: Array<{ attachmentId: string; observation: VisionObservation; cached: boolean }> = [];
  for (const attachment of attachments) {
    const key = { attachmentId: attachment.id, modelFingerprint, analysisVersion: VISION_ANALYSIS_VERSION };
    const cached = !force && await db("o_v04VisionAnalysis").where(key).first();
    if (cached) {
      try { result.push({ attachmentId: attachment.id, observation: visionObservation.parse(JSON.parse(cached.observationJson)), cached: true }); }
      catch (error) { throw visionFailure(error, model, attachment.id, "PILOT_VISION_SCHEMA_FAILED"); }
      continue;
    }
    let observation: VisionObservation;
    try {
      // AI SDK 6 treats a data: string as a downloadable URL and rejects it.
      // Bytes are normalized to an image file part and the OpenAI-compatible
      // adapter serializes that part as image_url with an inline data URL.
      const { row, bytes } = await getAgentAttachmentBytes(projectId, attachment.id);
      const image = { type: "image" as const, image: bytes, mediaType: row.mimeType };
      const session = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).trackedSession();
      const response = await session.invokeObject({
        schema: visionObservation,
        system: `Analyze only what is visibly present in the image. Return one valid JSON object using these exact fields and types: ${JSON.stringify(observationShape)}. Do not infer unseen content. Put uncertain claims in uncertainty. This image is a conversational reference, not an approved production asset. No markdown or text outside JSON.`,
        messages: [{ role: "user", content: [{ type: "text", text: "Describe the visible image faithfully as JSON. Do not invent brand authority or hidden text." }, image] }],
      });
      observation = visionObservation.parse(response.object);
    } catch (error) {
      throw visionFailure(error, model, attachment.id);
    }
    await db("o_v04VisionAnalysis").insert({ ...key, observationJson: JSON.stringify(observation), createdAt: Date.now() })
      .onConflict(["attachmentId", "modelFingerprint", "analysisVersion"]).merge({ observationJson: JSON.stringify(observation), createdAt: Date.now() });
    result.push({ attachmentId: attachment.id, observation, cached: false });
  }
  return result;
}

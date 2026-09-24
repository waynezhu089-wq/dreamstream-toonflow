import u from "@/utils";
import { CompositeError } from "./compositeGeometry";
import { executeCapability } from "./executeCapability";

export const BACKGROUND_CAPABILITY = "comfy.z-image-turbo.txt2img.v1";
export type BackgroundInput = { prompt: string; width: number; height: number; seed: number; backgroundCapabilityId: string };
export function validateBackground(input: BackgroundInput) {
  if (typeof input.backgroundCapabilityId !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/.test(input.backgroundCapabilityId))
    throw new CompositeError("BACKGROUND_CAPABILITY_UNSUPPORTED", "请选择已验证的背景 Capability 版本", 400);
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000 || !Number.isSafeInteger(input.seed) || input.seed < 0 ||
      ![input.width, input.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 16 === 0))
    throw new CompositeError("BACKGROUND_GENERATION_FAILED", "请输入有效提示词、256–2048 的 16 倍数尺寸和非负整数种子", 400);
}
// Business code supplies logical ports only; the version owns the Comfy graph.
export async function generateCompositeBackground(input: BackgroundInput) {
  validateBackground(input);
  try {
    const result = await executeCapability(input.backgroundCapabilityId, {
      prompt: input.prompt + "\nThe phone screen is a completely blank flat dark placeholder, with no user interface, no app, no text, no buttons, no icons and no logo. Keep the entire screen visible and unobstructed. Real screen content will be composited separately afterwards.",
      width: input.width, height: input.height, seed: input.seed,
    });
    const image = result.outputs.image;
    if (!image || Array.isArray(image) || !image.filePath) throw new CompositeError("BACKGROUND_GENERATION_FAILED", "Capability 未返回 image 输出");
    return { bytes: await u.oss.getFile(image.filePath), promptId: result.promptId!, executionId: result.executionId };
  } catch (e: any) { throw new CompositeError("BACKGROUND_GENERATION_FAILED", `背景生成失败：${e.code || "CAPABILITY_ERROR"}: ${e.message}`); }
}

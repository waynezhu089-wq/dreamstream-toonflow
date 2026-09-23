import { CompositeError } from "./compositeGeometry";

export const BACKGROUND_CAPABILITY = "comfy.z-image-turbo.txt2img.v1";
export type BackgroundInput = { prompt: string; width: number; height: number; seed: number; backgroundCapabilityId: string };
export function validateBackground(input: BackgroundInput) {
  if (input.backgroundCapabilityId !== BACKGROUND_CAPABILITY) throw new CompositeError("BACKGROUND_CAPABILITY_UNSUPPORTED", "当前只支持本地 Z-Image Turbo 背景能力");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000 || !Number.isSafeInteger(input.seed) || input.seed < 0 ||
      ![input.width, input.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 16 === 0))
    throw new CompositeError("BACKGROUND_GENERATION_FAILED", "请输入有效提示词、256–2048 的 16 倍数尺寸和非负整数种子", 400);
}
// Private adapter graph. Node identifiers never become storyboard semantics.
function graph(input: BackgroundInput) {
  return {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "dreamstream-background", images: ["57:8", 0] } },
    "57:30": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b_fp8_mixed.safetensors", type: "lumina2", device: "default" } },
    "57:29": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "57:33": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["57:27", 0] } },
    "57:8": { class_type: "VAEDecode", inputs: { samples: ["57:3", 0], vae: ["57:29", 0] } },
    "57:28": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_int8_convrot.safetensors", weight_dtype: "default" } },
    "57:27": { class_type: "CLIPTextEncode", inputs: { text: input.prompt + "\nThe phone screen is a completely blank flat dark placeholder, with no user interface, no app, no text, no buttons, no icons and no logo. Keep the entire screen visible and unobstructed. Real screen content will be composited separately afterwards.", clip: ["57:30", 0] } },
    "57:13": { class_type: "EmptySD3LatentImage", inputs: { width: input.width, height: input.height, batch_size: 1 } },
    "57:11": { class_type: "ModelSamplingAuraFlow", inputs: { shift: 3, model: ["57:28", 0] } },
    "57:3": { class_type: "KSampler", inputs: { seed: input.seed, steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple", denoise: 1, model: ["57:11", 0], positive: ["57:27", 0], negative: ["57:33", 0], latent_image: ["57:13", 0] } },
  };
}
export async function generateCompositeBackground(input: BackgroundInput) {
  validateBackground(input);
  const base = (process.env.COMFY_API_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
  const deadline = Date.now() + 600000;
  async function request(url: string, init?: RequestInit) {
    const response = await fetch(base + url, { ...init, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Comfy HTTP ${response.status}`);
    return response;
  }
  try {
    const submitted = await (await request("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph(input) }) })).json() as any;
    if (!submitted.prompt_id || Object.keys(submitted.node_errors ?? {}).length) throw new Error("背景工作流被拒绝");
    while (Date.now() < deadline) {
      const history = await (await request(`/history/${encodeURIComponent(submitted.prompt_id)}`)).json() as any;
      const run = history[submitted.prompt_id];
      if (run?.status?.status_str === "error") throw new Error("背景工作流执行失败");
      if (run?.status?.completed) {
        const image = run.outputs?.["9"]?.images?.[0];
        if (!image || image.type !== "output") throw new Error("背景工作流没有图片输出");
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: "output" });
        const bytes = Buffer.from(await (await request(`/view?${query}`)).arrayBuffer());
        return { bytes, promptId: String(submitted.prompt_id) };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("背景生成超时；请检查 Comfy 队列后重试");
  } catch (e: any) { throw new CompositeError("BACKGROUND_GENERATION_FAILED", `背景生成失败：${e.message}`); }
}

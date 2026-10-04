import sharp from "sharp";

export class DraftComfyError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const timeout = (ms: number) => AbortSignal.timeout(ms);
async function request(url: string, init: RequestInit = {}, ms = 15000) {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: timeout(ms) }); }
  catch { throw new DraftComfyError("COMFY_OFFLINE", "本地 ComfyUI 无法连接"); }
  if (!response.ok) throw new DraftComfyError("EXECUTION_FAILED", `ComfyUI HTTP ${response.status}`);
  return response;
}

export function localComfyOrigin(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DraftComfyError("WORKFLOW_UNAVAILABLE", "ComfyUI 地址无效"); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new DraftComfyError("WORKFLOW_UNAVAILABLE", "本地执行器仅支持无凭据的本机 HTTP 根地址");
  return url.origin;
}

const requiredNodes = ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"];
export async function inspectComfy(raw: string) {
  const base = localComfyOrigin(raw);
  try {
    const [stats, nodes] = await Promise.all([
      request(`${base}/system_stats`).then(r => r.json()) as Promise<any>,
      request(`${base}/object_info`).then(r => r.json()) as Promise<any>,
    ]);
    const missingNodes = requiredNodes.filter(node => !nodes[node]);
    const checkpoints: string[] = nodes.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    return { status: missingNodes.length || !checkpoints.length ? "INCOMPATIBLE" : "CONNECTED", baseUrl: base,
      version: stats.system?.comfyui_version ?? null, checkpoints, missingNodes };
  } catch (error) {
    if (error instanceof DraftComfyError && error.code === "COMFY_OFFLINE")
      return { status: "UNAVAILABLE", baseUrl: base, version: null, checkpoints: [], missingNodes: [] };
    return { status: "INCOMPATIBLE", baseUrl: base, version: null, checkpoints: [], missingNodes: [] };
  }
}

export type DraftWorkflow = { graph: Record<string, unknown>; outputNode: string; role: string; version: string };
const workflowVersion = "local-sdxl-draft-v1";
const roleByIntent: Record<string, string> = {
  CHARACTER_TURNAROUND: "TURNAROUND_SHEET", CREATURE_TURNAROUND: "MAIN_PREVIEW",
  VEHICLE_TURNAROUND: "MAIN_PREVIEW", OBJECT_REFERENCE: "MAIN_PREVIEW",
  ENVIRONMENT_ESTABLISHING: "ENVIRONMENT_ESTABLISHING", MATERIAL_STATE_BOARD: "MATERIAL_STATE_BOARD",
  CELESTIAL_REFERENCE: "CELESTIAL_REFERENCE",
};
export function draftWorkflowVersion() { return workflowVersion; }
export function buildDraftWorkflow(input: { intent: string; checkpoint: string; positive: string; negative: string; seed: number }): DraftWorkflow {
  const role = roleByIntent[input.intent];
  if (!role) throw new DraftComfyError("WORKFLOW_UNAVAILABLE", "当前生成意图没有本地图片工作流");
  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: input.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: input.positive, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: input.negative, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "5": { class_type: "KSampler", inputs: { seed: input.seed, steps: 12, cfg: 5, sampler_name: "euler", scheduler: "normal", denoise: 1,
      model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "DreamStreamV04Draft", images: ["6", 0] } },
  };
  return { graph, outputNode: "7", role, version: workflowVersion };
}

export async function submitDraft(base: string, workflow: DraftWorkflow) {
  const response = await request(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow.graph }) }, 30000);
  const result: any = await response.json();
  if (typeof result.prompt_id !== "string" || !result.prompt_id || Object.keys(result.node_errors ?? {}).length)
    throw new DraftComfyError("EXECUTION_FAILED", "ComfyUI 拒绝了草图工作流");
  return result.prompt_id as string;
}

export async function awaitDraft(base: string, promptId: string, outputNode: string, deadlineMs = 300000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const data: any = await (await request(`${base}/history/${encodeURIComponent(promptId)}`)).json();
    const history = data?.[promptId];
    if (history?.status?.status_str === "error") {
      const messages = JSON.stringify(history.status?.messages ?? []);
      throw new DraftComfyError(/out of memory|cuda oom/i.test(messages) ? "OUT_OF_MEMORY" : "EXECUTION_FAILED", "本地草图生成失败");
    }
    if (history?.status?.completed === true) {
      const image = history.outputs?.[outputNode]?.images?.[0];
      if (!image || image.type !== "output" || typeof image.filename !== "string" ||
          !/^[\w .-]+\.(png|jpe?g|webp)$/i.test(image.filename) ||
          typeof image.subfolder !== "string" || image.subfolder.includes("..") || image.subfolder.includes("\\"))
        throw new DraftComfyError("ARTIFACT_MISSING", "ComfyUI 没有返回有效图片");
      return image as { filename: string; subfolder: string; type: "output" };
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new DraftComfyError("EXECUTION_FAILED", "等待本地草图生成超时");
}

export async function downloadDraft(base: string, image: { filename: string; subfolder: string; type: "output" }) {
  const query = new URLSearchParams(image);
  const response = await request(`${base}/view?${query}`, {}, 30000);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 25_000_000) throw new DraftComfyError("ARTIFACT_MISSING", "草图文件为空或过大");
  let meta: sharp.Metadata;
  try { meta = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata(); }
  catch { throw new DraftComfyError("ARTIFACT_MISSING", "草图图片内容无效"); }
  if (!meta.width || !meta.height || !["png", "jpeg", "webp"].includes(meta.format ?? ""))
    throw new DraftComfyError("ARTIFACT_MISSING", "草图格式不受支持");
  return { bytes, width: meta.width, height: meta.height, mimeType: `image/${meta.format}`, extension: meta.format === "jpeg" ? "jpg" : meta.format! };
}

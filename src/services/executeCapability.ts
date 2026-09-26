import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Knex } from "knex";
import u from "@/utils";
import { CapabilityError, definitionHash, parseWorkflow, resolveInputs, validateBaseUrl } from "./capabilityContract";
import { getVersion } from "./capabilityRegistry";

const db = () => u.db as Knex;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type OutputFile = { filePath: string; url: string; mimeType: string };
export type CapabilityResult = { executionId: string; capabilityId: string; status: "SUCCEEDED" | "FAILED"; outputs: Record<string, OutputFile | OutputFile[]>; promptId: string | null; startedAt: number; completedAt: number; error: null | { code: string; message: string } };

async function request(url: string, options: RequestInit, deadline: number, failureCode: string) {
  const remain = deadline - Date.now();
  if (remain <= 0) throw new CapabilityError("COMFY_TIMEOUT", "Comfy 执行超时", 504);
  let response: Response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(Math.min(remain, 30000)) }); }
  catch (e: any) { throw new CapabilityError(e?.name === "TimeoutError" ? "COMFY_TIMEOUT" : "COMFY_UNAVAILABLE", `Comfy 无法连接：${e?.message || "网络异常"}`, 503); }
  if (!response.ok) throw new CapabilityError(failureCode, `Comfy HTTP ${response.status}`, 502);
  return response;
}
async function downloadImage(base: string, descriptor: any, executionId: string, portName: string, index: number, deadline: number): Promise<OutputFile> {
  if (!descriptor || typeof descriptor.filename !== "string" || !/^[\w .-]+\.(png|jpe?g|webp)$/i.test(descriptor.filename) || descriptor.filename === ".." ||
      typeof descriptor.subfolder !== "string" || descriptor.subfolder.includes("..") || descriptor.subfolder.includes("\\") || descriptor.subfolder.startsWith("/") ||
      descriptor.type !== "output") throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Comfy 输出文件描述不安全或不受支持", 502);
  const query = new URLSearchParams({ filename: descriptor.filename, subfolder: descriptor.subfolder, type: "output" });
  const response = await request(`${base}/view?${query}`, {}, deadline, "CAPABILITY_OUTPUT_NOT_FOUND");
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 25_000_000) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Comfy 图片超过 25 MB", 502);
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Comfy 图片为空", 502);
  for await (const chunk of response.body as any) { size += chunk.length; if (size > 25_000_000) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Comfy 图片超过 25 MB", 502); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  let metadata: sharp.Metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata(); }
  catch { throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Comfy 输出不是有效图片", 502); }
  if (!["png", "jpeg", "webp"].includes(metadata.format || "")) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "当前只支持 PNG/JPEG/WebP 图片输出", 502);
  const ext = metadata.format === "jpeg" ? "jpg" : metadata.format!;
  const filePath = `/capability/${executionId}/${portName}-${index}.${ext}`;
  await u.oss.writeFile(filePath, bytes);
  return { filePath, url: await u.oss.getFileUrl(filePath), mimeType: `image/${metadata.format}` };
}

// The production entry point always resolves an exact, VERIFIED version.
export async function executeCapability(capabilityId: string, inputs: unknown): Promise<CapabilityResult> {
  return execute(capabilityId, inputs, false);
}
// Test Run is the only path that may execute a DRAFT. It still records provenance.
export async function testCapability(capabilityId: string, inputs: unknown): Promise<CapabilityResult> {
  return execute(capabilityId, inputs, true);
}
async function execute(capabilityId: string, inputs: unknown, testRun: boolean): Promise<CapabilityResult> {
  const version = await getVersion(capabilityId), startedAt = Date.now(), executionId = randomUUID();
  const fingerprint = definitionHash(version);
  const record = { executionId, capabilityId: version.capabilityId, endpointId: version.endpointId, promptId: null as string | null,
    status: "RUNNING", inputs: JSON.stringify(inputs ?? null), outputs: "{}", error: null as string | null, definitionHash: fingerprint, startedAt, completedAt: null as number | null };
  await db()("o_capabilityExecution").insert(record);
  let promptId: string | null = null;
  try {
    if (version.status === "DISABLED") throw new CapabilityError("CAPABILITY_DISABLED", "该 Capability 版本已停用", 409);
    if (version.status !== "VERIFIED" && !(testRun && version.status === "DRAFT")) throw new CapabilityError("CAPABILITY_NOT_VERIFIED", "该 Capability 版本尚未验证", 409);
    const endpoint = await db()("o_capabilityEndpoint").where({ id: version.endpointId }).first();
    if (!endpoint || !endpoint.enabled) throw new CapabilityError("COMFY_UNAVAILABLE", "绑定的 Comfy Endpoint 不可用或已停用", 503);
    const base = validateBaseUrl(endpoint.baseUrl);
    const values = resolveInputs(version.inputPorts, inputs);
    const graph = parseWorkflow(version.workflowJson);
    for (const mapping of version.inputMappings) {
      if (!Object.hasOwn(graph, mapping.nodeId) || !Object.hasOwn(graph[mapping.nodeId].inputs, mapping.inputKey)) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", `输入映射 ${mapping.portName} 已失效`, 409);
      if (Object.hasOwn(values, mapping.portName)) graph[mapping.nodeId].inputs[mapping.inputKey] = values[mapping.portName];
    }
    const config = version.runtimeConfig, deadline = Date.now() + config.timeoutMs;
    const submission = await (await request(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) }, deadline, "COMFY_SUBMIT_FAILED")).json() as any;
    if (!submission || typeof submission.prompt_id !== "string" || !submission.prompt_id || Object.keys(submission.node_errors ?? {}).length) throw new CapabilityError("COMFY_SUBMIT_FAILED", "Comfy 拒绝工作流或没有返回 prompt_id", 502);
    promptId = submission.prompt_id;
    const submittedId = promptId!;
    await db()("o_capabilityExecution").where({ executionId }).update({ promptId });
    let history: any;
    while (Date.now() < deadline) {
      const response = await request(`${base}/history/${encodeURIComponent(submittedId)}`, {}, deadline, "COMFY_EXECUTION_FAILED");
      const data = await response.json() as any;
      history = data?.[submittedId];
      if (history?.status?.status_str === "error") throw new CapabilityError("COMFY_EXECUTION_FAILED", "Comfy 工作流执行失败", 502);
      if (history?.status?.completed === true) break;
      await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    if (history?.status?.completed !== true) throw new CapabilityError("COMFY_TIMEOUT", "Comfy 执行超时", 504);
    const outputs: CapabilityResult["outputs"] = {};
    for (const port of version.outputPorts) {
      const mapping = version.outputMappings.find((m: any) => m.portName === port.name);
      if (!mapping) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", `输出 Port ${port.name} 没有 Mapping`, 409);
      const value = history.outputs?.[mapping.nodeId]?.[mapping.field];
      if (value === undefined || value === null) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", `输出 ${port.label} 缺少节点字段`, 502);
      if (port.type !== "image" && port.type !== "image[]") throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", `当前 Bridge 尚不支持 ${port.type} 输出`, 409);
      if (!Array.isArray(value) || !value.length) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", `输出 ${port.label} 没有图片`, 502);
      const files: OutputFile[] = [];
      for (const [i, descriptor] of (port.type === "image" ? value.slice(0, 1) : value).entries()) files.push(await downloadImage(base, descriptor, executionId, port.name, i, deadline));
      outputs[port.name] = port.type === "image" ? files[0] : files;
    }
    const completedAt = Date.now();
    await db()("o_capabilityExecution").where({ executionId }).update({ status: "SUCCEEDED", outputs: JSON.stringify(outputs), completedAt });
    return { executionId, capabilityId: version.capabilityId, status: "SUCCEEDED", outputs, promptId, startedAt, completedAt, error: null };
  } catch (e: any) {
    const failure = e instanceof CapabilityError ? e : new CapabilityError("COMFY_EXECUTION_FAILED", e?.message || "Capability 执行失败", 502);
    const completedAt = Date.now();
    await db()("o_capabilityExecution").where({ executionId }).update({ status: "FAILED", promptId, error: JSON.stringify({ code: failure.code, message: failure.message }), completedAt });
    throw failure;
  }
}

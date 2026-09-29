import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Knex } from "knex";
import u from "@/utils";
import { CapabilityError, definitionHash, parseWorkflow, resolveInputs, validateBaseUrl } from "./capabilityContract";
import { decodeVersion, getVersion } from "./capabilityRegistry";
import { canonicalJson } from "./supervisor/contract";
import { type PinnedImageCapability, validateImageRole } from "./storyboardImageCapability";

const db = () => u.db as Knex;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type OutputFile = { filePath: string; url: string; mimeType: string; outputHash?: string; byteLength?: number };
export type CapabilityResult = { executionId: string; capabilityId: string; status: "SUCCEEDED" | "FAILED"; outputs: Record<string, OutputFile | OutputFile[]>; promptId: string | null; startedAt: number; completedAt: number; error: null | { code: string; message: string } };

async function request(url: string, options: RequestInit, deadline: number, failureCode: string, pinnedOrigin = false) {
  const remain = deadline - Date.now();
  if (remain <= 0) throw new CapabilityError("COMFY_TIMEOUT", "Comfy 执行超时", 504);
  let response: Response;
  try { response = await fetch(url, { ...options, ...(pinnedOrigin ? { redirect: "error" as const } : {}),
    signal: AbortSignal.timeout(Math.min(remain, 30000)) }); }
  catch (e: any) { throw new CapabilityError(e?.name === "TimeoutError" ? "COMFY_TIMEOUT" : "COMFY_UNAVAILABLE", `Comfy 无法连接：${e?.message || "网络异常"}`, 503); }
  if (!response.ok) throw new CapabilityError(failureCode, `Comfy HTTP ${response.status}`, 502);
  return response;
}
async function downloadImage(base: string, descriptor: any, executionId: string, portName: string, index: number, deadline: number,
  pinnedOrigin = false): Promise<OutputFile> {
  if (!descriptor || typeof descriptor.filename !== "string" || !/^[\w .-]+\.(png|jpe?g|webp)$/i.test(descriptor.filename) || descriptor.filename === ".." ||
      typeof descriptor.subfolder !== "string" || descriptor.subfolder.includes("..") || descriptor.subfolder.includes("\\") || descriptor.subfolder.startsWith("/") ||
      descriptor.type !== "output") throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Comfy 输出文件描述不安全或不受支持", 502);
  const query = new URLSearchParams({ filename: descriptor.filename, subfolder: descriptor.subfolder, type: "output" });
  const response = await request(`${base}/view?${query}`, {}, deadline, "CAPABILITY_OUTPUT_NOT_FOUND", pinnedOrigin);
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
  return { filePath, url: await u.oss.getFileUrl(filePath), mimeType: `image/${metadata.format}`,
    outputHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
}

async function runBridge(version: any, base: string, values: Record<string, unknown>, executionId: string,
  onPromptId: (promptId: string) => Promise<void>, pinnedOrigin = false) {
  const graph = parseWorkflow(version.workflowJson);
  for (const mapping of version.inputMappings) {
    if (!Object.hasOwn(graph, mapping.nodeId) || !Object.hasOwn(graph[mapping.nodeId].inputs, mapping.inputKey))
      throw new CapabilityError("CAPABILITY_MAPPING_INVALID", `输入映射 ${mapping.portName} 已失效`, 409);
    if (Object.hasOwn(values, mapping.portName)) graph[mapping.nodeId].inputs[mapping.inputKey] = values[mapping.portName];
  }
  const config = version.runtimeConfig, deadline = Date.now() + config.timeoutMs;
  const submission = await (await request(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }) }, deadline, "COMFY_SUBMIT_FAILED", pinnedOrigin)).json() as any;
  if (!submission || typeof submission.prompt_id !== "string" || !submission.prompt_id || Object.keys(submission.node_errors ?? {}).length)
    throw new CapabilityError("COMFY_SUBMIT_FAILED", "Comfy 拒绝工作流或没有返回 prompt_id", 502);
  const promptId = submission.prompt_id as string;
  await onPromptId(promptId);
  let history: any;
  while (Date.now() < deadline) {
    const response = await request(`${base}/history/${encodeURIComponent(promptId)}`, {}, deadline, "COMFY_EXECUTION_FAILED", pinnedOrigin);
    const data = await response.json() as any;
    history = data?.[promptId];
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
    for (const [i, descriptor] of (port.type === "image" ? value.slice(0, 1) : value).entries())
      files.push(await downloadImage(base, descriptor, executionId, port.name, i, deadline, pinnedOrigin));
    outputs[port.name] = port.type === "image" ? files[0] : files;
  }
  return { outputs, promptId };
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
    const produced = await runBridge(version, base, values, executionId, async id => {
      promptId = id;
      await db()("o_capabilityExecution").where({ executionId }).update({ promptId: id });
    });
    const outputs = produced.outputs;
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

export type CapabilityImageOutput = { filePath: string; mediaType: string; outputHash: string; byteLength: number;
  capabilityExecutionId: string; capabilityId: string; definitionHash: string; endpointId: string;
  endpointOrigin: string; promptId: string; outputPort: "image" };

function pinnedPlan(attempt: any): PinnedImageCapability {
  let plan: PinnedImageCapability;
  try { plan = JSON.parse(attempt.producerInput); } catch { throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Capability Attempt 缺少固定执行计划", 409); }
  if (attempt.producerType !== "CAPABILITY" || plan?.schemaVersion !== 1 ||
    plan.capabilityId !== attempt.producerRef || plan.roleAdapterKey !== "storyboard-image.text-to-image" ||
    plan.roleAdapterVersion !== 1 || plan.selectedOutputPort !== "image" || !plan.reservedExecutionId)
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Capability Attempt 执行计划无效", 409);
  return plan;
}

function savedImageOutput(plan: PinnedImageCapability, execution: any): CapabilityImageOutput {
  let outputs: any;
  try { outputs = JSON.parse(execution.outputs); } catch { outputs = null; }
  const image = outputs?.image;
  return { filePath: image?.filePath, mediaType: image?.mimeType, outputHash: image?.outputHash,
    byteLength: image?.byteLength, capabilityExecutionId: plan.reservedExecutionId, capabilityId: plan.capabilityId,
    definitionHash: plan.capabilityDefinitionHash, endpointId: plan.endpointId, endpointOrigin: plan.endpointOrigin,
    promptId: execution.promptId, outputPort: "image" };
}

// Pure, transaction-local linkage proof. Bridge byte validation happens before
// execution SUCCEEDED; no OSS/media read belongs in the B2 finish transaction.
export function proveCapabilityImageOutput(attempt: any, execution: any, output: CapabilityImageOutput | null): boolean {
  try {
    const plan = pinnedPlan(attempt);
    if (!execution || execution.status !== "SUCCEEDED" || !output || !execution.promptId ||
      execution.executionId !== plan.reservedExecutionId || execution.capabilityId !== plan.capabilityId ||
      execution.definitionHash !== plan.capabilityDefinitionHash || execution.endpointId !== plan.endpointId ||
      canonicalJson(JSON.parse(execution.inputs)) !== canonicalJson(plan.logicalInputs) ||
      output.capabilityExecutionId !== plan.reservedExecutionId || output.capabilityId !== plan.capabilityId ||
      output.definitionHash !== plan.capabilityDefinitionHash || output.endpointId !== plan.endpointId ||
      output.endpointOrigin !== plan.endpointOrigin || output.promptId !== execution.promptId || output.outputPort !== "image") return false;
    const persisted = savedImageOutput(plan, execution);
    if (!persisted.filePath || !persisted.mediaType || !persisted.outputHash || !persisted.byteLength ||
      canonicalJson(persisted) !== canonicalJson(output)) return false;
    const ext = output.mediaType === "image/png" ? "png" : output.mediaType === "image/jpeg" ? "jpg" :
      output.mediaType === "image/webp" ? "webp" : null;
    return !!ext && output.filePath === `/capability/${plan.reservedExecutionId}/image-0.${ext}` &&
      /^[a-f0-9]{64}$/.test(output.outputHash) && Number.isSafeInteger(output.byteLength) && output.byteLength > 0;
  } catch { return false; }
}

// Private Production seam: only o_capabilityExecution is mutated here. The
// Production worker remains the sole caller of B2 finish/fail ownership paths.
export async function executePinnedImageCapability(attemptId: string): Promise<
  { status: "RUNNING" } | { status: "SUCCEEDED"; output: CapabilityImageOutput }> {
  const attempt = await db()("o_productionAttempt").where({ attemptId }).first();
  if (!attempt) throw new CapabilityError("CAPABILITY_INPUT_INVALID", "Production Attempt 不存在", 409);
  const plan = pinnedPlan(attempt);
  const id = plan.reservedExecutionId;
  const existing = await db()("o_capabilityExecution").where({ executionId: id }).first();
  if (existing) return existingPinnedResult(attempt, existing);
  if (attempt.status !== "RUNNING" && attempt.status !== "STALE")
    throw new CapabilityError("CAPABILITY_INPUT_INVALID", "终态 Production Attempt 不能重新提交 Capability", 409);
  const startedAt = Date.now();
  try {
    await db()("o_capabilityExecution").insert({ executionId: id, capabilityId: plan.capabilityId,
      endpointId: plan.endpointId, promptId: null, status: "RUNNING", inputs: JSON.stringify(plan.logicalInputs),
      outputs: "{}", error: null, definitionHash: plan.capabilityDefinitionHash, startedAt, completedAt: null });
  } catch (error: any) {
    if (!/SQLITE_CONSTRAINT|SQLITE_BUSY/.test(String(error?.code ?? ""))) throw error;
    const winner = await db()("o_capabilityExecution").where({ executionId: id }).first();
    if (!winner) throw error;
    return existingPinnedResult(attempt, winner);
  }
  let promptId: string | null = null;
  try {
    // The read transaction is the external-admission linearization boundary.
    // No SQLite transaction is held while the pinned workflow uses the network.
    const context = await db().transaction(async q => {
      const row = await q("o_capabilityVersion").where({ capabilityId: plan.capabilityId }).first();
      const endpoint = await q("o_capabilityEndpoint").where({ id: plan.endpointId }).first();
      if (!row || row.status !== "VERIFIED" || !endpoint?.enabled) return null;
      let version: any, origin: string;
      try { version = decodeVersion(row); validateImageRole(version); origin = validateBaseUrl(endpoint.baseUrl); }
      catch { return null; }
      if (definitionHash(version) !== plan.capabilityDefinitionHash || version.endpointId !== plan.endpointId ||
        origin !== plan.endpointOrigin) return null;
      return { version, origin };
    });
    if (!context) throw new CapabilityError("CAPABILITY_EXECUTION_CONTEXT_CHANGED", "Capability Version 或 Endpoint 已变化", 409);
    const values = resolveInputs(context.version.inputPorts, plan.logicalInputs);
    const produced = await runBridge(context.version, plan.endpointOrigin, values, id, async value => {
      promptId = value;
      await db()("o_capabilityExecution").where({ executionId: id }).update({ promptId: value });
    }, true);
    const completedAt = Date.now();
    await db()("o_capabilityExecution").where({ executionId: id }).update({ status: "SUCCEEDED",
      outputs: JSON.stringify(produced.outputs), completedAt });
    const execution = await db()("o_capabilityExecution").where({ executionId: id }).first();
    const output = savedImageOutput(plan, execution);
    if (!proveCapabilityImageOutput(attempt, execution, output)) throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "Capability 输出来源证明失败", 502);
    return { status: "SUCCEEDED", output };
  } catch (error: any) {
    const failure = error instanceof CapabilityError ? error : new CapabilityError("COMFY_EXECUTION_FAILED", error?.message || "Capability 执行失败", 502);
    await db()("o_capabilityExecution").where({ executionId: id }).update({ status: "FAILED", promptId,
      error: JSON.stringify({ code: failure.code, message: failure.message }), completedAt: Date.now() });
    throw failure;
  }
}

function existingPinnedResult(attempt: any, row: any): { status: "RUNNING" } | { status: "SUCCEEDED"; output: CapabilityImageOutput } {
  const plan = pinnedPlan(attempt);
  let inputs: any = null;
  try { inputs = JSON.parse(row.inputs); } catch { /* invalid persisted identity */ }
  if (row.executionId !== plan.reservedExecutionId || row.capabilityId !== plan.capabilityId ||
    row.definitionHash !== plan.capabilityDefinitionHash || row.endpointId !== plan.endpointId ||
    canonicalJson(inputs) !== canonicalJson(plan.logicalInputs))
    throw new CapabilityError("PRODUCTION_CAPABILITY_PROVENANCE_MISMATCH", "已保存 Capability Execution 与 Attempt 不匹配", 409);
  if (row.status === "RUNNING") return { status: "RUNNING" };
  if (row.status === "FAILED") {
    let error: any;
    try { error = JSON.parse(row.error); } catch { error = null; }
    throw new CapabilityError(error?.code ?? "COMFY_EXECUTION_FAILED", error?.message ?? "Capability 执行失败", 502);
  }
  const output = savedImageOutput(plan, row);
  if (row.status !== "SUCCEEDED" || !proveCapabilityImageOutput(attempt, row, output))
    throw new CapabilityError("CAPABILITY_OUTPUT_NOT_FOUND", "已保存 Capability 输出来源证明失败", 502);
  return { status: "SUCCEEDED", output };
}

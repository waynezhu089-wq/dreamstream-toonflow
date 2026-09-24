import { createHash } from "node:crypto";
import { z } from "zod";

export class CapabilityError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const identifier = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(160);
export const familyKeySchema = identifier;
export const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/).max(180);
export const familySchema = z.object({ familyKey: familyKeySchema, displayName: z.string().trim().min(1).max(256), description: z.string().max(4000).default(""), category: z.string().trim().min(1).max(100), provider: z.string().trim().min(1).max(80).default("ComfyUI"), executorType: z.literal("COMFY_UI").default("COMFY_UI") }).strict();
export const inputTypes = ["text", "number", "boolean", "select", "image", "image[]", "audio", "video", "mask", "json"] as const;
export const outputTypes = ["text", "image", "image[]", "audio", "video", "json"] as const;
const portName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(80).refine(s => !["__proto__", "prototype", "constructor"].includes(s));
const nodeId = z.string().min(1).max(80).refine(s => !["__proto__", "prototype", "constructor"].includes(s));
export const inputPortSchema = z.object({ name: portName, type: z.enum(inputTypes), required: z.boolean(), label: z.string().trim().min(1).max(160), defaultValue: z.unknown().optional(), options: z.array(z.union([z.string(), z.number()])).optional() }).strict();
export const outputPortSchema = z.object({ name: portName, type: z.enum(outputTypes), label: z.string().trim().min(1).max(160) }).strict();
export const inputMappingSchema = z.object({ portName, nodeId, inputKey: nodeId }).strict();
export const outputMappingSchema = z.object({ portName, nodeId, field: nodeId }).strict();
export const runtimeConfigSchema = z.object({ timeoutMs: z.number().int().min(100).max(600000).default(120000), pollIntervalMs: z.number().int().min(10).max(5000).default(1000) }).strict();
export const versionDraftSchema = z.object({ endpointId: z.string().uuid(), workflowJson: z.union([z.string(), z.record(z.string(), z.unknown())]), inputPorts: z.array(inputPortSchema).max(50), outputPorts: z.array(outputPortSchema).min(1).max(50), inputMappings: z.array(inputMappingSchema).max(100), outputMappings: z.array(outputMappingSchema).min(1).max(100), runtimeConfig: runtimeConfigSchema.default({ timeoutMs: 120000, pollIntervalMs: 1000 }) }).strict();

export function parseWorkflow(raw: string | Record<string, unknown>) {
  if (typeof raw === "string" && raw.length > 4_000_000) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Workflow JSON 超过 4 MB");
  let graph: Record<string, any>;
  try { graph = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Comfy API Workflow JSON 不能解析"); }
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.keys(graph).length || Object.keys(graph).length > 2000) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "请提供 Comfy API Format Workflow 对象");
  for (const [id, node] of Object.entries(graph)) {
    if (!["__proto__", "prototype", "constructor"].includes(id) && node && typeof node === "object" && !Array.isArray(node) && typeof node.class_type === "string" && node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs)) continue;
    throw new CapabilityError("CAPABILITY_MAPPING_INVALID", `Workflow 节点 ${id} 不是 API Format`);
  }
  return graph;
}
function unique(items: { name?: string; portName?: string }[]) { const names = items.map(i => i.name ?? i.portName); return names.length === new Set(names).size; }
export function validateDefinition(raw: unknown) {
  let d: z.infer<typeof versionDraftSchema>;
  try { d = versionDraftSchema.parse(raw); }
  catch { throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Port、Mapping、Endpoint 或 Runtime Config 格式不合法"); }
  const graph = parseWorkflow(d.workflowJson);
  if (![d.inputPorts, d.outputPorts, d.inputMappings, d.outputMappings].every(unique)) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Port 或 Mapping 名称重复");
  for (const port of d.inputPorts) if (port.defaultValue !== undefined) validateInputValue(port, port.defaultValue);
  const inputs = new Set(d.inputPorts.map(p => p.name)), outputs = new Set(d.outputPorts.map(p => p.name));
  if (d.inputPorts.some(p => !d.inputMappings.some(m => m.portName === p.name)) || d.outputPorts.some(p => !d.outputMappings.some(m => m.portName === p.name))) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "每个 Port 都需要直接 Mapping");
  for (const mapping of d.inputMappings) {
    if (!inputs.has(mapping.portName) || !Object.hasOwn(graph, mapping.nodeId) || !Object.hasOwn(graph[mapping.nodeId].inputs, mapping.inputKey)) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", `输入映射 ${mapping.portName} 指向不存在的节点或输入`);
  }
  for (const mapping of d.outputMappings) {
    if (!outputs.has(mapping.portName) || !Object.hasOwn(graph, mapping.nodeId)) throw new CapabilityError("CAPABILITY_MAPPING_INVALID", `输出映射 ${mapping.portName} 指向不存在的节点`);
  }
  return { ...d, workflowJson: JSON.stringify(graph) };
}
export function validateInputValue(port: z.infer<typeof inputPortSchema>, value: unknown) {
  const type = port.type;
  const valid = type === "text" ? typeof value === "string" : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "boolean" ? typeof value === "boolean" : type === "select" ? (typeof value === "string" || typeof value === "number") && !!port.options?.includes(value) : false;
  if (!valid) throw new CapabilityError("CAPABILITY_INPUT_INVALID", `${port.label} 类型不正确或当前 Bridge 尚不支持该输入类型`);
}
export function resolveInputs(ports: z.infer<typeof inputPortSchema>[], raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CapabilityError("CAPABILITY_INPUT_INVALID", "请输入 Logical Inputs 对象");
  const provided = raw as Record<string, unknown>, allowed = new Set(ports.map(p => p.name));
  if (Object.keys(provided).some(key => !allowed.has(key))) throw new CapabilityError("CAPABILITY_INPUT_INVALID", "包含未声明的 Logical Input");
  const values: Record<string, unknown> = Object.create(null);
  for (const port of ports) {
    const value = Object.hasOwn(provided, port.name) ? provided[port.name] : port.defaultValue;
    if (value === undefined || value === null) { if (port.required) throw new CapabilityError("CAPABILITY_INPUT_INVALID", `缺少必填输入 ${port.label}`); continue; }
    validateInputValue(port, value); values[port.name] = value;
  }
  return values;
}
export function definitionHash(d: Record<string, any>) { return createHash("sha256").update(JSON.stringify([d.workflowJson,d.inputPorts,d.outputPorts,d.inputMappings,d.outputMappings,d.endpointId,d.runtimeConfig])).digest("hex"); }

export function validateBaseUrl(raw: string) {
  let url: URL; try { url = new URL(raw); } catch { throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Endpoint URL 无效"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new CapabilityError("CAPABILITY_MAPPING_INVALID", "Endpoint 只接受无凭据的 HTTP(S) 根地址");
  return url.origin;
}

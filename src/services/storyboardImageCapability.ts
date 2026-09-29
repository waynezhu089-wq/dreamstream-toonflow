import { randomInt, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { ProductionGateError } from "./advertisementGate";
import { definitionHash, parseWorkflow, resolveInputs, validateBaseUrl, validateDefinition } from "./capabilityContract";
import { decodeVersion, versionFields } from "./capabilityRegistry";

export const imageRoleKey = "storyboard-image.text-to-image";
export const imageRoleVersion = 1;
export const registrySourceAdapterKey = "storyboard.image-source.registry.v1";
export const provenanceMismatchCode = "PRODUCTION_CAPABILITY_PROVENANCE_MISMATCH";

export type RegistryVersion = { version: any; definitionHash: string };
export type RegistryVersions = Map<string, RegistryVersion | "INVALID" | null>;
export type PinnedImageCapability = {
  schemaVersion: 1;
  roleAdapterKey: typeof imageRoleKey;
  roleAdapterVersion: 1;
  reservedExecutionId: string;
  capabilityId: string;
  capabilityDefinitionHash: string;
  endpointId: string;
  endpointOrigin: string;
  logicalInputs: { prompt: string; width: number; height: number; seed: number };
  selectedOutputPort: "image";
};

const reject = (code: string, message: string): never => { throw new ProductionGateError(message, code, 409); };
export const isRegistryImageSelection = (selection: { capabilityId: string | null; resolvedFrom: string }) =>
  selection.resolvedFrom === "RECIPE" || !!selection.capabilityId && selection.capabilityId !== "toonflow.image.v1";

export function imageDimensions(quality: unknown, ratio: unknown) {
  const dimensions: Record<string, [number, number]> = {
    "1K:16:9": [1024, 576], "1K:9:16": [576, 1024],
    "2K:16:9": [2048, 1152], "2K:9:16": [1152, 2048],
    "4K:16:9": [4096, 2304], "4K:9:16": [2304, 4096],
  };
  const value = dimensions[`${quality}:${ratio}`];
  if (!value) reject("CAPABILITY_ROLE_INCOMPATIBLE", "图片质量或比例不属于当前 Capability 角色允许的尺寸");
  return { width: value[0], height: value[1] };
}

export function validateImageRole(version: any): RegistryVersion {
  let valid: ReturnType<typeof validateDefinition>;
  try {
    valid = validateDefinition(Object.fromEntries(versionFields.map(field => [field, version[field]])));
    if (definitionHash(valid) !== definitionHash(version)) throw new Error("definition mismatch");
    const inputs = valid.inputPorts;
    const expected = { prompt: "text", width: "number", height: "number", seed: "number" };
    if (inputs.length !== 4 || valid.outputPorts.length !== 1 || valid.outputPorts[0].name !== "image" || valid.outputPorts[0].type !== "image" ||
      inputs.some(port => expected[port.name as keyof typeof expected] !== port.type || !port.required ||
        Object.hasOwn(port, "defaultValue") || Object.hasOwn(port, "options")) ||
      valid.inputMappings.length !== 4 || valid.outputMappings.length !== 1 || valid.outputMappings[0].portName !== "image" ||
      new Set(valid.inputMappings.map(mapping => mapping.portName)).size !== 4) throw new Error("role ports mismatch");
    const graph = parseWorkflow(valid.workflowJson);
    const output = valid.outputMappings[0];
    if (!Object.hasOwn(graph[output.nodeId] ?? {}, "class_type")) throw new Error("output mapping mismatch");
  } catch { reject("CAPABILITY_ROLE_INCOMPATIBLE", "Capability 定义不符合四输入、一图片输出的角色合同"); }
  return { version, definitionHash: definitionHash(valid!) };
}

export async function readRegistryVersions(q: Knex.Transaction, ids: string[]): Promise<RegistryVersions> {
  const unique = [...new Set(ids)].sort();
  const result: RegistryVersions = new Map(unique.map(id => [id, null]));
  if (!unique.length) return result;
  for (const row of await q("o_capabilityVersion").whereIn("capabilityId", unique)) {
    try {
      const version = decodeVersion(row);
      const valid = validateDefinition(Object.fromEntries(versionFields.map(field => [field, version[field]])));
      if (definitionHash(valid) !== definitionHash(version)) throw new Error("definition mismatch");
      result.set(row.capabilityId, { version, definitionHash: definitionHash(valid) });
    }
    catch { result.set(row.capabilityId, "INVALID"); }
  }
  return result;
}

export async function createPinnedImageProducer(q: Knex.Transaction, selected: RegistryVersion | null | undefined,
  capabilityId: string, prompt: string, width: number, height: number,
  endpointRow?: any, drawSeed: () => number = () => randomInt(0, 0x100000000)) {
  if (!selected) throw new ProductionGateError("精确 Capability Version 不存在或定义无效", "CAPABILITY_NOT_FOUND", 409);
  const version = selected.version;
  if (version.status === "DISABLED") reject("CAPABILITY_DISABLED", "Capability 已停用");
  if (version.status !== "VERIFIED") reject("CAPABILITY_NOT_VERIFIED", "Capability 尚未验证");
  validateImageRole(version);
  if (!prompt) reject("CAPABILITY_INPUT_INVALID", "图片执行 Prompt 为空");
  const allowed = [[1024, 576], [576, 1024], [2048, 1152], [1152, 2048], [4096, 2304], [2304, 4096]];
  if (!allowed.some(([w, h]) => w === width && h === height)) reject("CAPABILITY_ROLE_INCOMPATIBLE", "尺寸无效");
  const endpoint = endpointRow === undefined ? await q("o_capabilityEndpoint").where({ id: version.endpointId }).first() : endpointRow;
  if (!endpoint?.enabled) reject("COMFY_UNAVAILABLE", "Capability Endpoint 不可用");
  let origin: string;
  try { origin = validateBaseUrl(endpoint.baseUrl); }
  catch { reject("CAPABILITY_ROLE_INCOMPATIBLE", "Capability Endpoint 地址无效"); }
  const seed = drawSeed();
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) reject("CAPABILITY_INPUT_INVALID", "Capability seed 无效");
  const logicalInputs = resolveInputs(version.inputPorts, { prompt, width, height, seed }) as PinnedImageCapability["logicalInputs"];
  return { schemaVersion: 1, roleAdapterKey: imageRoleKey, roleAdapterVersion: 1,
    reservedExecutionId: randomUUID(), capabilityId, capabilityDefinitionHash: selected.definitionHash,
    endpointId: endpoint.id, endpointOrigin: origin!, logicalInputs, selectedOutputPort: "image" } satisfies PinnedImageCapability;
}

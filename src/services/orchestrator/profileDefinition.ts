import { createHash } from "node:crypto";
import { z } from "zod";

export class ProfileError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const profileKeySchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(160);
export const stageKeySchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(160);
const gateKeySchema = z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/).max(160);
export const versionNumber = (value: unknown) => {
  const match = typeof value === "string" && /^v([1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ProfileError("PROFILE_VERSION_NOT_FOUND", "请指定精确 Profile 版本，例如 v1");
  return Number(match[1]);
};
export const versionLabel = (value: number) => `v${value}`;
export const positiveId = (value: unknown) => {
  const parsed = z.number().int().positive().safeParse(value);
  if (!parsed.success) throw new ProfileError("PROFILE_SCOPE_INVALID", "请选择有效的当前项目和制作单元");
  return parsed.data;
};

const stageSchema = z.object({
  stageKey: stageKeySchema,
  displayName: z.string().trim().min(1).max(256),
  description: z.string().max(4000),
  required: z.boolean(),
  allowSkip: z.boolean(),
  uiOrder: z.number().int(),
  entryGateKey: gateKeySchema.nullable(),
  exitGateKey: gateKeySchema.nullable(),
}).strict();
export const operationKeySchema = z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/).max(160);
const enforcedStageSchema = stageSchema.extend({ operationKeys: z.array(operationKeySchema) }).strict();
const transitionSchema = z.object({ fromStageKey: stageKeySchema, toStageKey: stageKeySchema }).strict();
const commonDefinition = {
  initialStageKey: stageKeySchema,
  transitions: z.array(transitionSchema).max(1000),
};
const legacyDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  ...commonDefinition,
  stages: z.array(stageSchema).min(1).max(200),
}).strict();
const enforcedDefinitionSchema = z.object({
  schemaVersion: z.literal(2),
  runtimeControl: z.literal("ENFORCED"),
  ...commonDefinition,
  stages: z.array(enforcedStageSchema).min(1).max(200),
}).strict();
export const definitionSchema = z.discriminatedUnion("schemaVersion", [legacyDefinitionSchema, enforcedDefinitionSchema]);
export type ProfileDefinition = z.infer<typeof definitionSchema>;

export function validateDefinition(input: unknown): ProfileDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Profile 定义字段或类型不合法");
  const definition = parsed.data;
  const keys = new Set(definition.stages.map(stage => stage.stageKey));
  const orders = new Set(definition.stages.map(stage => stage.uiOrder));
  if (keys.size !== definition.stages.length || orders.size !== definition.stages.length || !keys.has(definition.initialStageKey)) {
    throw new ProfileError("PROFILE_DEFINITION_INVALID", "Stage Key、显示顺序必须唯一，且初始 Stage 必须存在");
  }
  if (definition.stages.some(stage => stage.required && stage.allowSkip)) throw new ProfileError("PROFILE_DEFINITION_INVALID", "必需 Stage 不能允许跳过");
  if (definition.schemaVersion === 2) {
    const operationKeys = definition.stages.flatMap(stage => stage.operationKeys);
    if (new Set(operationKeys).size !== operationKeys.length) throw new ProfileError("PROFILE_DEFINITION_INVALID", "operationKey 在 Profile Version 中必须唯一");
  }
  const outgoing = new Map([...keys].map(key => [key, [] as string[]]));
  const edges = new Set<string>();
  for (const edge of definition.transitions) {
    if (!keys.has(edge.fromStageKey) || !keys.has(edge.toStageKey)) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Stage transition 引用了不存在的 Stage");
    const signature = `${edge.fromStageKey}\0${edge.toStageKey}`;
    if (edges.has(signature)) throw new ProfileError("PROFILE_DEFINITION_INVALID", "Stage transition 重复");
    edges.add(signature);
    outgoing.get(edge.fromStageKey)!.push(edge.toStageKey);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new ProfileError("PROFILE_DEFINITION_INVALID", "ADVANCE Stage Graph 不能有循环");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of outgoing.get(key)!) visit(next);
    visiting.delete(key); visited.add(key);
  };
  visit(definition.initialStageKey);
  if (visited.size !== keys.size) throw new ProfileError("PROFILE_DEFINITION_INVALID", "所有 Stage 必须从初始 Stage 可达");
  return definition;
}

export function definitionHash(definition: ProfileDefinition) { return createHash("sha256").update(JSON.stringify(definition)).digest("hex"); }

const advertisementKeys = ["brief", "asset-planning", "asset-preparation", "director-planning", "storyboard-table", "storyboard-board", "supervisor-review", "image-production", "video-production", "edit-subtitle-voice", "qc", "final-output"];
const advertisementNames = ["Brief", "Asset Planning", "Asset Preparation", "Director Planning", "Storyboard Table", "Storyboard Board", "Supervisor Review", "Storyboard Image Production", "Video Production", "Edit / Subtitle / Voice", "QC", "Final Output"];
export const advertisementV1 = validateDefinition({
  schemaVersion: 1, initialStageKey: "brief",
  stages: advertisementKeys.map((stageKey, index) => ({ stageKey, displayName: advertisementNames[index], description: "", required: true, allowSkip: false, uiOrder: (index + 1) * 10, entryGateKey: null, exitGateKey: stageKey === "asset-preparation" ? "advertisement.asset-ready" : null })),
  transitions: advertisementKeys.slice(1).map((toStageKey, index) => ({ fromStageKey: advertisementKeys[index], toStageKey })),
});

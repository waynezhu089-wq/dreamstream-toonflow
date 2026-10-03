import { createHash, randomUUID } from "node:crypto";
import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { requireModel } from "@/services/modelPreset";
import { PilotError, readPilot } from "./service";
import { buildProjectAgentContext, renderProjectAgentSystem } from "./agentContext";
import { visualSpecSchema } from "./visualSpecContract";
import { previewVisualSpec } from "./visualSpec";

const id = z.number().int().positive();
const request = z.object({
  projectId: id, scriptId: id, instruction: z.string().trim().min(1).max(4000),
  scope: z.object({ type: z.enum(["PROJECT", "CREATIVE", "ASSET", "SHOT", "VISUAL_SYSTEM"]), key: z.string().max(128).optional() }).strict(),
  optionalDraft: z.object({ sourceAssetRevision: id, spec: visualSpecSchema }).strict().optional(),
}).strict();
const visualOutput = z.object({ summary: z.string().min(1).max(500), rationale: z.string().max(1000), patch: z.record(z.string(), z.unknown()) }).strict();
const shotOutput = z.object({ summary: z.string().min(1).max(500), rationale: z.string().max(1000), patch: z.object({
  prompt: z.string().min(1).max(20000).optional(), videoDesc: z.string().max(20000).optional(),
  duration: z.number().positive().max(600).optional(),
}).strict() }).strict();
const visualFields = new Set(["visualIdentitySummary", "silhouette", "scale", "proportion", "primaryPalette", "secondaryPalette", "materials", "surfaceLanguage", "distinctiveFeatures", "continuityNotes", "details"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function mergeAppearance(base: any, patch: Record<string, unknown>): any {
  for (const key of Object.keys(patch)) if (!visualFields.has(key))
    throw new PilotError("PILOT_ACTION_FIELD_INVALID", `视觉提案不能修改 ${key}`, 422);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (key === "details" && value && typeof value === "object" && !Array.isArray(value)) {
      // Nested appearance is merged; omitted identity/real-reference fields remain unchanged.
      const merge = (target: any, source: any): any => {
        for (const [field, next] of Object.entries(source)) {
          if (!(field in target)) throw new PilotError("PILOT_ACTION_FIELD_INVALID", `未知视觉字段 ${field}`, 422);
          target[field] = next && typeof next === "object" && !Array.isArray(next) && target[field] && typeof target[field] === "object" && !Array.isArray(target[field])
            ? merge({ ...target[field] }, next) : next;
        }
        return target;
      };
      merged.details = merge(structuredClone(base.details), value);
    } else merged[key] = value;
  }
  return visualSpecSchema.parse(merged);
}
function targetConfirmation(state: Awaited<ReturnType<typeof readPilot>>) {
  return { status: "NEEDS_TARGET_CONFIRMATION", applied: false, candidates: [
    ...state.assets.filter((asset: any) => asset.status === "ACTIVE").slice(0, 2).map((asset: any) => ({ type: "ASSET", key: asset.canonicalKey, label: asset.name })),
    ...state.storyboards.slice(0, 1).map((shot: any) => ({ type: "SHOT", key: String(shot.id), label: `镜头 ${shot.index ?? shot.id}` })),
  ].slice(0, 3) };
}
export async function proposeAgentAction(input: unknown) {
  const data = request.parse(input);
  const state = await readPilot({ projectId: data.projectId, scriptId: data.scriptId });
  const selected = data.scope;
  if (!selected.key || !["ASSET", "VISUAL_SYSTEM", "SHOT"].includes(selected.type)) return targetConfirmation(state);
  const identityRequest = selected.type !== "SHOT" && /(?:改名|重命名|名字改成|名称改成|属于|归属|不.*独立资产|退休|删除身份|name|owner|identity)/i.test(data.instruction);
  if (identityRequest) return { ...targetConfirmation(state), suggestedTargetType: "ASSET_IDENTITY" };
  let source: any, system: string, schema: typeof visualOutput | typeof shotOutput;
  let targetType: "VISUAL_SPEC" | "STORYBOARD_SHOT";
  if (selected.type === "SHOT") {
    const shot = state.storyboards.find((row: any) => String(row.id) === selected.key);
    if (!shot) throw new PilotError("PILOT_ACTION_TARGET_INVALID", "当前制作单元没有这个镜头", 404);
    source = { id: shot.id, index: shot.index, prompt: shot.prompt, videoDesc: shot.videoDesc, duration: shot.duration };
    schema = shotOutput; targetType = "STORYBOARD_SHOT";
    system = "你是分镜导演，只返回 JSON 对象：summary、rationale、patch。patch 只包含用户明确要求变动的 prompt、videoDesc、duration；省略未修改字段。不要修改图片执行字段、素材绑定或工序状态。提案尚未应用。";
  } else {
    const asset = state.assets.find((row: any) => row.status === "ACTIVE" && row.canonicalKey === selected.key);
    if (!asset) throw new PilotError("PILOT_ACTION_TARGET_INVALID", "当前项目没有这个有效素材身份", 404);
    const confirmed = state.visualSpecs.find((row: any) => row.canonicalKey === selected.key && row.effectiveStatus === "CONFIRMED");
    if (data.optionalDraft && data.optionalDraft.sourceAssetRevision !== asset.revision)
      throw new PilotError("PILOT_ACTION_SOURCE_STALE", "当前草案的素材身份版本已过期", 409);
    const base = data.optionalDraft?.spec ?? confirmed?.spec;
    if (!base) return { status: "NEEDS_VISUAL_DRAFT", applied: false, targetKey: asset.canonicalKey, message: "先生成或建立这项素材的视觉草案，再让 Agent 定向修改。" };
    if (base.assetKind !== asset.assetKind) throw new PilotError("PILOT_ACTION_SOURCE_STALE", "视觉草案与当前素材类型不符", 409);
    source = { asset: { canonicalKey: asset.canonicalKey, name: asset.name, description: asset.description, assetKind: asset.assetKind, revision: asset.revision,
      identityAnchors: asset.identityAnchors, mustPreserve: asset.mustPreserve, forbiddenChanges: asset.forbiddenChanges, sourcePolicy: asset.sourcePolicy }, spec: base };
    schema = visualOutput; targetType = "VISUAL_SPEC";
    system = "你是视觉导演，只返回 JSON 对象：summary、rationale、patch。patch 只写需要修改的外观字段，可用 visualIdentitySummary、silhouette、scale、proportion、primaryPalette、secondaryPalette、materials、surfaceLanguage、distinctiveFeatures、continuityNotes、details；details 只写实际改动的子字段。不得修改 assetKind、身份锚点、必须保留、禁止改变、真实参考来源或真实 Logo/UI；不得 AI 重绘真实素材。提案尚未应用。";
  }
  let model: Awaited<ReturnType<typeof requireModel>>;
  try { model = await requireModel(data.projectId, "text"); }
  catch { throw new PilotError("PILOT_ACTION_MODEL_UNAVAILABLE", "请先配置文本模型", 502); }
  const context = await buildProjectAgentContext({ projectId: data.projectId, scriptId: data.scriptId,
    currentStage: "studio", currentRoute: "studio", selectedObject: { type: selected.type === "SHOT" ? "SHOT" : "ASSET", key: selected.key } }, data.instruction);
  system = `${renderProjectAgentSystem(context)}\n${system}`;
  let output: unknown;
  try {
    const response = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({ system,
      messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ instruction: data.instruction, source }) }] }],
      output: Output.json() });
    output = response.output;
  } catch (error) {
    console.error("[V04 AgentAction][ModelFailure]", { correlationId: randomUUID(), projectId: data.projectId, targetType,
      errorName: error instanceof Error ? error.name : "Error" });
    throw new PilotError("PILOT_ACTION_MODEL_FAILED", "Agent 未能生成操作提案，请检查文本模型", 502);
  }
  const parsed = schema.safeParse(output);
  if (!parsed.success) throw new PilotError("PILOT_ACTION_SCHEMA_FAILED", "操作提案结构不完整，请重试", 422);
  if (targetType === "STORYBOARD_SHOT") {
    const candidate = parsed.data as z.infer<typeof shotOutput>;
    if (!Object.keys(candidate.patch).length) throw new PilotError("PILOT_ACTION_NO_CHANGE", "没有可预览的镜头修改", 409);
    return { status: "PROPOSED", targetType, targetKey: selected.key, sourceRevision: digest(source), summary: candidate.summary,
      rationale: candidate.rationale, proposal: { type: "EDIT", storyboardId: source.id, patch: candidate.patch },
      affectedObjects: [{ type: "SHOT", key: selected.key }], applied: false };
  }
  const candidate = parsed.data as z.infer<typeof visualOutput>;
  const spec = mergeAppearance(source.spec, candidate.patch);
  const asset = source.asset;
  const preview = await previewVisualSpec({ projectId: data.projectId, scriptId: data.scriptId, canonicalKey: selected.key,
    sourceAssetRevision: asset.revision, spec });
  return { status: "PROPOSED", targetType, targetKey: selected.key, sourceRevision: asset.revision, summary: candidate.summary,
    rationale: candidate.rationale, proposal: { canonicalKey: selected.key, sourceAssetRevision: asset.revision, spec,
      qualityWarnings: preview.issues.map(issue => ({ path: issue, message: "需要人工补齐" })) },
    affectedObjects: [{ type: "ASSET", key: selected.key }], applied: false };
}

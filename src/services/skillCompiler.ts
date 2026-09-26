import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Knex } from "knex";
import u from "@/utils";
import { resolveProductionProfile } from "@/agents/productionAgent/profile";
import { readState } from "@/services/advertisementGate";
import { textModelForProject } from "@/services/modelPreset";
import { productionSpec, semanticProductionSpec, executionProductionSpec } from "@/services/storyboardProduction";
import { SkillError, sourceHash, versionLabel } from "./skillContract";
import { resolveSkill } from "./skillRegistry";

const ids = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), storyboardId: z.number().int().positive() });
const compileInput = ids.extend({ supportingSkillId: z.string().optional(), supportingSkillVersion: z.string().optional() }).strict();
const db = () => u.db;
const modelKey = "productionAgent:storyboardGenAgent";

async function shotContext(input: z.infer<typeof ids>, q: Knex | Knex.Transaction = db()) {
  const project = await q("o_project").where({ id: input.projectId }).first();
  const script = await q("o_script").where({ id: input.scriptId, projectId: input.projectId }).first();
  const shot = await q("o_storyboard").where({ id: input.storyboardId, projectId: input.projectId, scriptId: input.scriptId }).first();
  if (!project || !script || !shot) throw new SkillError("SKILL_SOURCE_INVALID", "镜头不属于当前项目和制作单元", 404);
  if (resolveProductionProfile(project).key !== "advertisement") throw new SkillError("SKILL_TEMPLATE_INVALID", "首版 IMAGE_PROMPT Compiler 仅接入广告 Storyboard", 409);
  const spec = productionSpec(shot);
  if (spec.productionMode === "REAL_ASSET_DIRECT") throw new SkillError("SKILL_TEMPLATE_INVALID", "真实素材直用镜头无需 AI 图片 Prompt", 409);
  const gate = await readState(input.projectId, input.scriptId, q.isTransaction ? q as Knex.Transaction : undefined);
  if (!gate.ready) throw new SkillError("SKILL_RESOLUTION_FAILED", "当前广告制作单元尚未通过素材 Gate", 409);
  const assets = gate.planItems.filter(item => item.bindingValid && item.ready).map(item => ({ assetKey: item.assetKey, name: item.name, category: item.category, required: item.required, sourcePolicy: item.sourcePolicy, assetId: item.assetId, ready: item.ready }));
  const realReferences = assets.filter(item => item.sourcePolicy === "REAL_REQUIRED" && [spec.primaryAssetId, ...spec.referenceAssetIds].includes(item.assetId));
  if (spec.productionMode === "AI_REFERENCE_GENERATE" && realReferences.length) throw new SkillError("SKILL_TEMPLATE_INVALID", "真实 UI/Logo 不能通过 AI 参考图生成来维持像素真实性", 409);
  if (spec.productionMode === "AI_TEXT_TO_IMAGE" && realReferences.length) throw new SkillError("SKILL_TEMPLATE_INVALID", "纯文生图不能重画已绑定的真实 UI/Logo 素材", 409);
  if (spec.productionMode === "AI_TEXT_TO_IMAGE" && spec.primaryAssetId !== null) throw new SkillError("SKILL_TEMPLATE_INVALID", "纯文生图镜头不能把真实主素材当作 AI 生成内容", 409);
  if (spec.productionMode === "REAL_AI_COMPOSITE" && spec.primaryAssetId === null) throw new SkillError("SKILL_TEMPLATE_INVALID", "真实素材合成镜头缺少主素材", 409);
  if (spec.primaryAssetId !== null && !assets.some(item => item.assetId === spec.primaryAssetId && item.sourcePolicy === "REAL_REQUIRED")) throw new SkillError("SKILL_TEMPLATE_INVALID", "主真实素材必须是当前 Asset Plan 中有效的 REAL_REQUIRED 绑定", 409);
  return { project, shot, spec, assets };
}
async function stableCapabilityContext(capabilityId: string | null, q: Knex | Knex.Transaction = db()) {
  if (!capabilityId) return { capabilityId: null, contractAvailable: false, inputPorts: [] };
  const row = await q("o_capabilityVersion").where({ capabilityId }).first();
  if (!row || row.status !== "VERIFIED") return { capabilityId, contractAvailable: false, inputPorts: [] };
  const ports = JSON.parse(row.inputPorts) as { name: string; type: string; required?: boolean }[];
  return { capabilityId, contractAvailable: true, inputPorts: ports.map(port => ({ name: port.name, type: port.type, required: port.required })) };
}
function cleanModelOutput(text: unknown, currentImagePrompt: string, semanticPrompt: string) {
  if (typeof text !== "string") throw new SkillError("SKILL_COMPILE_FAILED", "文本模型未返回 Prompt", 502);
  const value = text.trim().replace(/^```(?:text|markdown)?\s*\n?/i, "").replace(/\n?```$/, "").trim();
  if (!value || [currentImagePrompt, semanticPrompt].some(prompt => prompt.trim() && value.startsWith(prompt.trim()))) {
    throw new SkillError("SKILL_COMPILE_FAILED", "模型只追加旧 Prompt 或未生成完整新 Prompt，请重新编译", 502);
  }
  return value;
}
export async function compileImagePrompt(input: unknown) {
  const value = compileInput.parse(input);
  if ((value.supportingSkillId === undefined) !== (value.supportingSkillVersion === undefined)) throw new SkillError("SKILL_BINDING_INVALID", "Supporting Skill 必须提供精确 ID 和 Version");
  const { project, shot, spec, assets } = await shotContext(value);
  const resolved = await resolveSkill({ projectId: value.projectId, scriptId: value.scriptId, storyboardId: value.storyboardId, skillType: "IMAGE_PROMPT", profileKey: resolveProductionProfile(project).key });
  // Explicit supporting CONTINUITY is optional; unrelated Skill types are never loaded.
  let supportingInstruction: string | null = null;
  if (value.supportingSkillId) {
    const { loadSkill } = await import("./skillRegistry");
    const supporting = await loadSkill(value.supportingSkillId, value.supportingSkillVersion!);
    if (supporting.skillType !== "CONTINUITY") throw new SkillError("SKILL_TEMPLATE_INVALID", "只允许显式加载 CONTINUITY Supporting Skill");
    supportingInstruction = supporting.runtimeInstruction;
  }
  const capabilityContext = await stableCapabilityContext(spec.capabilityId);
  const inputContext = {
    projectId: value.projectId, scriptId: value.scriptId, storyboardId: value.storyboardId,
    currentStoryboard: { id: shot.id, semanticPrompt: shot.prompt ?? "", currentImagePrompt: shot.imagePrompt ?? null, videoDesc: shot.videoDesc ?? "",
      productionSpecHash: sourceHash(JSON.stringify(spec)), semanticProductionSpec: semanticProductionSpec(spec), executionProductionSpec: executionProductionSpec(spec) },
    assetConstraints: { assets, constraintsHash: sourceHash(JSON.stringify(assets)), preserveRealPixels: true, prohibition: "真实 UI、Logo、包装文字、产品标签不得由 AI 重画；REAL_AI_COMPOSITE 仅生成不含真实界面的背景" },
    capabilityContext, overrideChain: resolved.overrideChain,
    supportingSkill: supportingInstruction ? { skillId: value.supportingSkillId, skillVersion: value.supportingSkillVersion, runtimeInstruction: supportingInstruction } : null,
  };
  let modelReference: string;
  try { modelReference = await textModelForProject(value.projectId, modelKey); }
  catch { throw new SkillError("SKILL_COMPILE_MODEL_UNAVAILABLE", "请先配置文本模型，再编译图片 Prompt", 409); }
  if (modelReference === modelKey) {
    // textModelForProject retains Toonflow's agent deployment fallback. Check
    // that fallback at point of use so an empty deployment has a clear error.
    const mode = await db()("o_setting").where({ key: "agentUseMode" }).first();
    const deployed = await db()("o_agentDeploy").where({ key: mode?.value === "0" ? "productionAgent" : modelKey }).first();
    const fallback = mode?.value === "1" ? null : await db()("o_agentDeploy").where({ key: "productionAgent" }).first();
    if (!deployed?.modelName && !fallback?.modelName) throw new SkillError("SKILL_COMPILE_MODEL_UNAVAILABLE", "请先配置文本模型，再编译图片 Prompt", 409);
  }
  const system = `你是广告 Storyboard IMAGE_PROMPT Compiler。请生成一条完整的图片执行 Prompt，忠实实现但不得重新定义已审核的 Semantic Prompt 语义意图。请区分 semanticPrompt 与 currentImagePrompt；不要把旧图片 Prompt 与 Override 机械相接。Skill 是方法，Capability 是执行契约。不得要求 AI 重画真实 UI、Logo、包装文字或产品标签。REAL_AI_COMPOSITE 只描述背景，真实界面留给确定性合成。只能输出最终 Prompt 正文，不输出解释。\n\nResolved IMAGE_PROMPT Skill (${resolved.skillId} @ ${resolved.skillVersion}):\n${resolved.runtimeInstruction}${supportingInstruction ? `\n\nExplicit CONTINUITY Skill:\n${supportingInstruction}` : ""}`;
  let result: any;
  try { result = await u.Ai.Text(modelReference as Parameters<typeof u.Ai.Text>[0]).invoke({ system, messages: [{ role: "user", content: JSON.stringify(inputContext) }] }); }
  catch (error: any) {
    if (/未找到.*(?:模型|配置)|模型.*(?:不可用|未配置)|请先配置/.test(String(error?.message ?? ""))) throw new SkillError("SKILL_COMPILE_MODEL_UNAVAILABLE", "请先配置文本模型，再编译图片 Prompt", 409);
    throw new SkillError("SKILL_COMPILE_FAILED", error?.message || "图片 Prompt 编译失败", 502);
  }
  const outputPrompt = cleanModelOutput(result?.text ?? result?._output, String(shot.imagePrompt ?? ""), String(shot.prompt ?? ""));
  const compileId = randomUUID(), now = Date.now();
  await db()("o_skillCompile").insert({ compileId, projectId: value.projectId, scriptId: value.scriptId, storyboardId: value.storyboardId,
    skillId: resolved.skillId, skillVersion: Number(resolved.skillVersion.slice(1)), skillDefinitionHash: resolved.definitionHash,
    resolutionTrace: JSON.stringify(resolved.resolutionTrace), overrideChain: JSON.stringify(resolved.overrideChain),
    inputContext: JSON.stringify(inputContext), outputPrompt, modelReference, createdAt: now, appliedAt: null });
  return { compileId, currentSemanticPrompt: shot.prompt ?? "", currentImagePrompt: shot.imagePrompt ?? null, compiledImagePrompt: outputPrompt,
    resolvedSkill: { skillId: resolved.skillId, skillVersion: resolved.skillVersion, skillStatus: resolved.skillStatus, resolvedFrom: resolved.resolvedFrom, overrideChain: resolved.overrideChain, resolutionTrace: resolved.resolutionTrace },
    capabilityContext, createdAt: now, appliedAt: null };
}
export async function readCompile(input: { compileId: string; projectId: number; scriptId: number; storyboardId: number }) {
  const value = z.object({ compileId: z.string().uuid(), ...ids.shape }).strict().parse(input);
  const row = await db()("o_skillCompile").where(value).first();
  if (!row) throw new SkillError("SKILL_SOURCE_INVALID", "Compile Preview 不属于当前镜头", 404);
  return { ...row, skillVersion: versionLabel(Number(row.skillVersion)), resolutionTrace: JSON.parse(row.resolutionTrace), overrideChain: JSON.parse(row.overrideChain), inputContext: JSON.parse(row.inputContext) };
}
export async function applyCompile(input: { compileId: string; projectId: number; scriptId: number; storyboardId: number }) {
  const value = z.object({ compileId: z.string().uuid(), ...ids.shape }).strict().parse(input);
  try { return await db().transaction(async trx => {
    const row = await trx("o_skillCompile").where({ compileId: value.compileId, projectId: value.projectId, scriptId: value.scriptId, storyboardId: value.storyboardId }).first();
    if (!row) throw new SkillError("SKILL_SOURCE_INVALID", "Compile Preview 不属于当前镜头", 404);
    if (row.appliedAt) throw new SkillError("SKILL_BINDING_INVALID", "此 Compile 已应用，请重新编译", 409);
    const { shot, spec, assets } = await shotContext(value, trx);
    const snapshot = JSON.parse(row.inputContext), original = snapshot.currentStoryboard;
    if (String(shot.prompt ?? "") !== String(original.semanticPrompt ?? "") || String(shot.videoDesc ?? "") !== String(original.videoDesc ?? "") ||
      (shot.imagePrompt ?? null) !== (original.currentImagePrompt ?? null) || sourceHash(JSON.stringify(spec)) !== original.productionSpecHash ||
      sourceHash(JSON.stringify(assets)) !== snapshot.assetConstraints.constraintsHash ||
      JSON.stringify(await stableCapabilityContext(spec.capabilityId, trx)) !== JSON.stringify(snapshot.capabilityContext)) {
      throw new SkillError("SKILL_BINDING_INVALID", "镜头或图片执行上下文已改变，请重新编译", 409);
    }
    const current = await resolveSkill({ projectId: value.projectId, scriptId: value.scriptId, storyboardId: value.storyboardId, skillType: "IMAGE_PROMPT", profileKey: "advertisement" }, trx);
    if (current.skillId !== row.skillId || current.skillVersion !== versionLabel(Number(row.skillVersion)) || current.definitionHash !== row.skillDefinitionHash || JSON.stringify(current.overrideChain) !== row.overrideChain) {
      throw new SkillError("SKILL_BINDING_INVALID", "Skill 绑定或 Override 已改变，请重新编译", 409);
    }
    const appliedAt = Date.now();
    const changed = await trx("o_skillCompile").where({ compileId: value.compileId, appliedAt: null }).update({ appliedAt });
    if (changed !== 1) throw new SkillError("SKILL_BINDING_INVALID", "Compile 状态已改变，请重新编译", 409);
    const persistedSpec = shot.productionSpec ? JSON.parse(shot.productionSpec) : {};
    await trx("o_storyboard").where({ id: value.storyboardId, projectId: value.projectId, scriptId: value.scriptId }).update({
      imagePrompt: row.outputPrompt, productionSpec: JSON.stringify({ ...persistedSpec, schemaVersion: persistedSpec.schemaVersion ?? 1,
        promptSkillId: row.skillId, promptSkillVersion: versionLabel(Number(row.skillVersion)) }),
    });
    const updated = await trx("o_storyboard").where({ id: value.storyboardId, projectId: value.projectId, scriptId: value.scriptId }).first();
    return { compileId: value.compileId, storyboard: { ...updated, ...productionSpec(updated) }, appliedAt };
  }); } catch (error: any) {
    if (/SQLITE_BUSY|SQLITE_CONSTRAINT/.test(String(error?.code))) throw new SkillError("SKILL_BINDING_INVALID", "并发修改冲突，请重新编译", 409);
    throw error;
  }
}

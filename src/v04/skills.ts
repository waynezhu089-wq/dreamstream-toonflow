import { Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { db } from "@/utils/db";
import { requireModel } from "@/services/modelPreset";
import { PilotError, readPilot } from "./service";

const id = z.number().int().positive();
const request = z.object({ projectId: id, scriptId: id, method: z.enum(["ASSET_EXTRACTION", "ASSET_PROMPTS", "STORYBOARD_BATCH"]) }).strict();
const candidate = z.object({ name: z.string().trim().min(1).max(256), category: z.enum(["CHAR", "ACC", "PROP", "PRODUCT", "LOC", "BRAND", "UI", "FX"]), description: z.string().max(4000), identityAnchors: z.array(z.string().max(300)).max(30), mustPreserve: z.array(z.string().max(300)).max(30), forbiddenChanges: z.array(z.string().max(300)).max(30), ownerKey: z.string().max(128).nullable(), variantOf: z.string().max(128).nullable(), sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]), prompt: z.string().max(8000) }).strict();
const outputSchemas = {
  ASSET_EXTRACTION: z.object({ candidates: z.array(candidate).max(80), mergeSuggestions: z.array(z.object({ candidateIndex: z.number().int().nonnegative(), existingCanonicalKey: z.string(), reason: z.string() }).strict()).max(80) }).strict(),
  ASSET_PROMPTS: z.object({ prompts: z.array(z.object({ canonicalKey: z.string(), prompt: z.string().min(1).max(8000), reason: z.string().max(1000) }).strict()).max(100) }).strict(),
  STORYBOARD_BATCH: z.object({ shots: z.array(z.object({ duration: z.number().positive().max(600), prompt: z.string().min(1).max(20000), videoDesc: z.string().max(20000), productionMode: z.enum(["REAL_ASSET_DIRECT", "AI_TEXT_TO_IMAGE", "REAL_AI_COMPOSITE"]), primaryKey: z.string().nullable(), canonicalKeys: z.array(z.string()).max(50) }).strict()).min(1).max(100) }).strict(),
};
const instructions = {
  ASSET_EXTRACTION: "方法 v04.asset-extraction.v1：从 Creative/Script、项目对话与已接受/否决决定识别持续存在的视觉实体。身份特征、独立可携带物、状态变体分层。真实 UI/Logo/产品文字必须 REAL_REQUIRED。名称相同或同义只能建议合并，绝不自行合并。",
  ASSET_PROMPTS: "方法 v04.asset-prompt.v1：为每个已有 Canonical Asset 生成独立且一致的素材 Prompt 草案。维持 identityAnchors 和 mustPreserve，遵守 forbiddenChanges。真实 UI、Logo、文字不能由 AI 重画。只返回现有 canonicalKey。",
  STORYBOARD_BATCH: "方法 v04.storyboard-batch.v1：根据已确认 Creative 和 Asset Bible 提出约目标时长的分镜方案。引用只用给定 canonicalKey。真实 UI/Logo 必须 REAL_ASSET_DIRECT 或 REAL_AI_COMPOSITE，不要用 AI_TEXT_TO_IMAGE 伪造真实界面。此结果只是提案，不是生产数据库。",
} as const;
export async function previewSkill(input: unknown) {
  const data = request.parse(input);
  const state = await readPilot(data);
  const model = await requireModel(data.projectId, "text");
  const messages = await db("memories").where({ isolationKey: `project:${data.projectId}:projectAgent`, type: "message" }).orderBy("createTime", "desc").limit(30);
  const source = { creative: state.creative, acceptedOrRejectedDecisions: state.decisions.filter(d => ["ACCEPTED", "REJECTED"].includes(d.status)), conversation: messages.reverse().map(m => ({ role: m.role, content: m.content })), assets: state.assets.filter(a => a.status === "ACTIVE") };
  const schema = outputSchemas[data.method];
  const skeleton = data.method === "ASSET_EXTRACTION" ? { candidates: [{ name: "", category: "CHAR", description: "", identityAnchors: [], mustPreserve: [], forbiddenChanges: [], ownerKey: null, variantOf: null, sourcePolicy: "AI_ALLOWED", prompt: "" }], mergeSuggestions: [] } :
    data.method === "ASSET_PROMPTS" ? { prompts: [{ canonicalKey: "", prompt: "", reason: "" }] } : { shots: [{ duration: 3, prompt: "", videoDesc: "", productionMode: "AI_TEXT_TO_IMAGE", primaryKey: null, canonicalKeys: [] }] };
  const system = `${instructions[data.method]}\nReturn one valid JSON object only. Use this JSON structure: ${JSON.stringify(skeleton)}. No markdown or extra fields. Do not claim changes were applied.`;
  try {
    // The three method schemas are a discriminated runtime union; AI SDK's
    // generic helper needs one concrete type, while the selected Zod schema
    // is still validated below before any proposal leaves this boundary.
    const result = await u.Ai.Text(model as Parameters<typeof u.Ai.Text>[0]).invoke({ system, messages: [{ role: "user", content: JSON.stringify(source) }], output: Output.object({ schema: schema as any }) });
    const output = schema.parse(result.output) as any;
    const keys = new Set(source.assets.map(a => a.canonicalKey));
    if (data.method === "ASSET_PROMPTS" && output.prompts.some((p: any) => !keys.has(p.canonicalKey))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 提案引用了不存在的素材身份", 422);
    if (data.method === "STORYBOARD_BATCH" && output.shots.some((s: any) => [...s.canonicalKeys, ...(s.primaryKey ? [s.primaryKey] : [])].some(k => !keys.has(k)))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 分镜引用了不存在的素材身份", 422);
    if (data.method === "ASSET_EXTRACTION" && output.mergeSuggestions.some((s: any) => s.candidateIndex >= output.candidates.length || !keys.has(s.existingCanonicalKey))) throw new PilotError("PILOT_SKILL_REFERENCE_INVALID", "AI 合并建议引用无效", 422);
    return { method: data.method, skillId: `v04.${data.method.toLowerCase().replaceAll('_','-')}.v1`, output, applied: false, sourceVersion: state.creative.version };
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new PilotError("PILOT_SKILL_FAILED", "批量提案生成失败，请检查文本模型并重试", 502);
  }
}

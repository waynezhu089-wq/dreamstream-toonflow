import type { Knex } from "knex";
import { createHash } from "node:crypto";
import { NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import u from "@/utils";
import { textModelForProject } from "@/services/modelPreset";
import { SkillError, genericTemplate, imagePromptTemplate, skillIdSchema, skillTypeSchema, templateFor, validateContent, type SkillContent, type SkillType } from "./skillContract";
import { getSkill, readAndSanitizeSelectedSource, sanitizeSelectedSource, saveBuilderDraft } from "./skillRegistry";

const db = () => u.db as Knex;
const positive = z.number().int().positive();
const instruction = z.string().trim().min(3).max(8000);
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const prefixes: Record<SkillType, string> = {
  CONCEPT_CREATIVE: "concept-creative", SCRIPT: "script", DIRECTOR: "director", STORYBOARD: "storyboard",
  IMAGE_PROMPT: "image-prompt", VIDEO_PROMPT: "video-prompt", CONTINUITY: "continuity", EDIT_PACING: "edit-pacing",
  AUDIO_MUSIC: "audio-music", SUPERVISOR: "supervisor", QC: "qc", DISTRIBUTION: "distribution",
};
const familyMeta = z.object({ skillId: skillIdSchema, displayName: z.string().trim().min(1).max(256), skillType: skillTypeSchema, description: z.string().trim().max(4000).default(""), tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]) }).strict();
function candidateSchema(skillType: SkillType) {
  return z.object({
    suggestedSlug: z.string().optional(),
    displayName: z.string().trim().min(1).max(256),
    description: z.string().trim().max(4000),
    tags: z.array(z.string().trim().min(1).max(100)).max(50),
    content: skillType === "IMAGE_PROMPT" ? imagePromptTemplate : genericTemplate,
  }).strict();
}
const selectedSource = z.object({ projectId: positive, scriptId: positive, storyboardId: positive, skillType: z.literal("IMAGE_PROMPT"), instruction: instruction.optional() }).strict();
type Source = Awaited<ReturnType<typeof readAndSanitizeSelectedSource>>;

function modelUnavailable(error: unknown) {
  const message = String((error as any)?.message ?? error ?? "");
  return /未找到.*(?:模型|配置|部署)|模型.*(?:不可用|未配置|不存在)|provider.*(?:unavailable|not found)|请先配置|universalAi.*(?:not found|missing)/i.test(message);
}
function diagnosticText(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  return String(value)
    .replace(/\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|secret|password)\b\s*[:=]\s*[^\s,;}]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]+\b/gi, "[REDACTED_CREDENTIAL]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[REDACTED_CREDENTIAL]")
    .slice(0, 1000);
}
function diagnosticCause(value: unknown, depth = 0): unknown {
  if (depth > 2 || value === undefined || value === null) return null;
  if (typeof value !== "object") return diagnosticText(value);
  const error = value as Record<string, unknown>;
  return {
    name: diagnosticText(error.name), message: diagnosticText(error.message), code: diagnosticText(error.code),
    statusCode: diagnosticText(error.statusCode), status: diagnosticText(error.status),
    cause: depth < 2 ? diagnosticCause(error.cause, depth + 1) : null,
  };
}
function logStructuredOutputFailure(error: unknown, modelReference: string, attempt: number) {
  try {
    const details = error && typeof error === "object" ? error as Record<string, any> : {};
    const name = diagnosticText(details.name);
    console.error("[SkillBuilder][StructuredOutputFailure]", {
      modelReference: diagnosticText(modelReference), attempt,
      name, message: diagnosticText(details.message ?? error), code: diagnosticText(details.code),
      statusCode: diagnosticText(details.statusCode), status: diagnosticText(details.status),
      cause: diagnosticCause(details.cause), responseStatus: diagnosticText(details.response?.status),
      aiSdkErrorType: typeof name === "string" && name.startsWith("AI_") ? name : null,
      provider: diagnosticText(details.provider), modelId: diagnosticText(details.modelId),
    });
  } catch { /* Diagnostics must never change the Builder error contract. */ }
}
async function modelFor(projectId?: number) {
  if (!projectId) return "universalAi";
  try { return await textModelForProject(projectId, "productionAgent:storyboardGenAgent"); }
  catch { throw new SkillError("SKILL_BUILDER_MODEL_UNAVAILABLE", "请先配置可用的文本模型。", 409); }
}
function safeSlug(suggested: string | undefined, displayName: string, content: SkillContent) {
  const valid = slug.safeParse(suggested);
  if (valid.success) return valid.data;
  const name = displayName.normalize("NFKD").toLowerCase();
  const fromName = /^[\x00-\x7f]+$/.test(name) ? name.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100).replace(/-$/, "") : "";
  if (slug.safeParse(fromName).success) return fromName;
  return `skill-${createHash("sha256").update(JSON.stringify({ displayName, content })).digest("hex").slice(0, 12)}`;
}
function cleanProjectContent(value: unknown, source: Source): unknown {
  if (typeof value === "string") return sanitizeSelectedSource(value, source.projectName, source.assetNames);
  if (Array.isArray(value)) return value.map(item => cleanProjectContent(item, source));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanProjectContent(item, source)]));
  return value;
}
async function generateCandidate(skillType: SkillType, userInput: Record<string, unknown>, projectId?: number, source?: Source) {
  const modelReference = await modelFor(projectId);
  const schema = candidateSchema(skillType);
  const system = `你是 Dream Stream Skill Builder。根据自然语言经验生成可复用的 ${skillType} Skill 候选，遵循提供的结构化输出 Schema，填齐 content 中所有字段；不适用的文字字段用空字符串，列表字段用空数组。Return a valid JSON object only. The JSON must conform to the provided schema. Do not output markdown or any text outside the JSON object. 不得复制项目 ID、内部文件路径、客户/产品专有名称或 SKU。suggestedSlug 只是可选建议，不确定时省略。IMAGE_PROMPT 必须保留真实 UI、Logo、包装文字、产品标签和产品文字不得由 AI 重画、改字或伪造的约束。`;
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await u.Ai.Text(modelReference as Parameters<typeof u.Ai.Text>[0]).invoke({
        system,
        messages: [{ role: "user", content: JSON.stringify({ ...userInput, repair: feedback || undefined }) }],
        output: Output.object({ schema }),
      });
      const parsed = schema.parse(result.output);
      const content = validateContent(skillType, templateFor(skillType), source ? cleanProjectContent(parsed.content, source) : parsed.content);
      const safeMeta = source ? cleanProjectContent({ displayName: parsed.displayName, description: parsed.description, tags: parsed.tags }, source) as Pick<typeof parsed, "displayName" | "description" | "tags"> : parsed;
      return { suggestedSlug: safeSlug(parsed.suggestedSlug, safeMeta.displayName, content), displayName: safeMeta.displayName, description: safeMeta.description, tags: safeMeta.tags, candidateContent: content, modelReference };
    } catch (error) {
      if (modelUnavailable(error)) throw new SkillError("SKILL_BUILDER_MODEL_UNAVAILABLE", "请先配置可用的文本模型。", 409);
      if (!NoObjectGeneratedError.isInstance(error) && !(error instanceof z.ZodError) && !(error instanceof SkillError && error.code === "SKILL_TEMPLATE_INVALID")) {
        logStructuredOutputFailure(error, modelReference, attempt + 1);
        throw new SkillError("SKILL_BUILDER_FAILED", "Skill 候选生成失败，请稍后重试。", 502);
      }
      feedback = `上次结构化候选未通过 Schema 或模板校验。请按相同 Schema 重新生成完整 JSON 对象。错误：${String((error as any)?.message ?? error).slice(0, 500)}`;
    }
  }
  throw new SkillError("SKILL_BUILDER_INVALID_OUTPUT", "AI 两次返回的 Skill 结构仍不合法，请稍后重试。", 502);
}
async function availableId(skillType: SkillType, suggestedSlug: string) {
  const base = `${prefixes[skillType]}.${slug.parse(suggestedSlug)}`;
  let value = base, suffix = 2;
  while (await db()("o_skillRegistry").where({ skillId: value }).first()) value = `${base}-${suffix++}`;
  return value;
}
function validateFamily(value: unknown) {
  const family = familyMeta.parse(value);
  if (!family.skillId.startsWith(`${prefixes[family.skillType]}.`)) throw new SkillError("SKILL_TEMPLATE_INVALID", "Skill ID 必须使用当前类型的固定前缀");
  return family;
}
function fieldChanges(before: SkillContent, after: SkillContent) {
  return Object.keys(after).filter(field => JSON.stringify((before as any)[field]) !== JSON.stringify((after as any)[field])).map(field => {
    const oldValue = (before as any)[field], newValue = (after as any)[field];
    const empty = (value: unknown) => value === "" || Array.isArray(value) && value.length === 0;
    return { field, changeType: empty(oldValue) ? "ADDED" : empty(newValue) ? "REMOVED" : "MODIFIED", before: oldValue, after: newValue, accepted: false };
  });
}
export async function quickPreview(input: unknown) {
  const value = z.object({ skillType: skillTypeSchema, displayName: z.string().trim().max(256).optional(), instruction, projectId: positive.optional() }).strict().parse(input);
  const generated = await generateCandidate(value.skillType, { instruction: value.instruction, preferredName: value.displayName }, value.projectId);
  return { ...generated, skillId: await availableId(value.skillType, generated.suggestedSlug), skillType: value.skillType };
}
export async function quickSave(input: unknown) {
  const value = z.object({ family: familyMeta, candidateContent: z.unknown(), sourceMetadata: z.object({ builder: z.enum(["AI_QUICK", "MANUAL_ADVANCED"]).optional(), modelReference: z.string().max(256).optional(), instructionHash: z.string().length(64).optional() }).strict().optional() }).strict().parse(input);
  const family = validateFamily(value.family);
  return saveBuilderDraft({ family, content: validateContent(family.skillType, templateFor(family.skillType), value.candidateContent), sourceType: "MANUAL", sourceData: { builder: value.sourceMetadata?.builder ?? "AI_QUICK", modelReference: value.sourceMetadata?.modelReference ?? null, instructionHash: value.sourceMetadata?.instructionHash ?? null, generatedAt: Date.now() } });
}
async function existingVersion(skillId: string, version: string, expected: "DRAFT" | "ACTIVE") {
  const result = await getSkill({ skillId, version });
  const row = result.versions[0];
  if (row.status !== expected) throw new SkillError("SKILL_DRAFT_NOT_ALLOWED", `需要 ${expected} 版本`, 409);
  return { family: result.family, row };
}
export async function draftPreview(input: unknown) {
  const value = z.object({ skillId: skillIdSchema, version: z.string(), instruction, projectId: positive.optional() }).strict().parse(input);
  const { family, row } = await existingVersion(value.skillId, value.version, "DRAFT");
  const generated = await generateCandidate(family.skillType, { instruction: value.instruction, currentContent: row.content, task: "完善当前 Draft，不创建新版本" }, value.projectId);
  return { candidateContent: generated.candidateContent, changes: fieldChanges(row.content, generated.candidateContent), modelReference: generated.modelReference };
}
export async function improvePreview(input: unknown) {
  const value = z.object({ skillId: skillIdSchema, version: z.string(), instruction, projectId: positive.optional() }).strict().parse(input);
  const { family, row } = await existingVersion(value.skillId, value.version, "ACTIVE");
  const generated = await generateCandidate(family.skillType, { instruction: value.instruction, baseContent: row.content, task: "生成完整改进候选，保留未要求改变的字段" }, value.projectId);
  return { candidateContent: generated.candidateContent, changes: fieldChanges(row.content, generated.candidateContent), modelReference: generated.modelReference };
}
export async function projectDerivedPreview(input: unknown) {
  const value = selectedSource.parse(input);
  const source = await readAndSanitizeSelectedSource({ projectId: value.projectId, scriptId: value.scriptId, sourceId: value.storyboardId, sourceType: "STORYBOARD_PROMPT" });
  const generated = await generateCandidate(value.skillType, { selectedSource: source.safe, instruction: value.instruction || "提炼这条 Prompt 的可复用视觉方法" }, value.projectId, source);
  return { ...generated, skillType: value.skillType, skillId: await availableId(value.skillType, generated.suggestedSlug), sourceHash: source.sourceHash };
}
export async function projectDerivedSave(input: unknown) {
  const value = z.object({ projectId: positive, scriptId: positive, storyboardId: positive, expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/), family: familyMeta, candidateContent: z.unknown(), modelReference: z.string().max(256).optional() }).strict().parse(input);
  const family = validateFamily(value.family);
  if (family.skillType !== "IMAGE_PROMPT") throw new SkillError("SKILL_TEMPLATE_INVALID", "Storyboard 图片 Prompt 只能沉淀为 IMAGE_PROMPT");
  return db().transaction(async trx => {
    const source = await readAndSanitizeSelectedSource({ projectId: value.projectId, scriptId: value.scriptId, sourceId: value.storyboardId, sourceType: "STORYBOARD_PROMPT" }, trx);
    if (source.sourceHash !== value.expectedSourceHash) throw new SkillError("SKILL_SOURCE_CHANGED", "来源 Prompt 已变化，请重新预览。", 409);
    const content = validateContent(family.skillType, templateFor(family.skillType), cleanProjectContent(value.candidateContent, source));
    const cleanFamily = validateFamily(cleanProjectContent(family, source));
    return saveBuilderDraft({ family: cleanFamily, content, sourceType: "PROJECT_DERIVED", sourceData: { sourceType: "STORYBOARD_PROMPT", sourceId: value.storyboardId, sourceHash: source.sourceHash, sourceSnapshot: source.snapshot, generatedAt: Date.now(), modelReference: value.modelReference ?? null } }, trx);
  });
}

// The UI performs the human-selected field merge; the existing version/edit and
// version/create services validate the complete result again before a write.
export { fieldChanges };

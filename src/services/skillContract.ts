import { createHash } from "node:crypto";
import { z } from "zod";

export const skillTypes = ["CONCEPT_CREATIVE", "SCRIPT", "DIRECTOR", "STORYBOARD", "IMAGE_PROMPT", "VIDEO_PROMPT", "CONTINUITY", "EDIT_PACING", "AUDIO_MUSIC", "SUPERVISOR", "QC", "DISTRIBUTION"] as const;
export const skillTypeSchema = z.enum(skillTypes);
export type SkillType = z.infer<typeof skillTypeSchema>;
export const scopeTypes = ["SYSTEM", "PROFILE", "RECIPE", "PROJECT", "STAGE", "SHOT"] as const;
export const scopeTypeSchema = z.enum(scopeTypes);
export type ScopeType = z.infer<typeof scopeTypeSchema>;
export const skillIdSchema = z.string().trim().min(3).max(160).regex(/^[a-z][a-z0-9._-]*$/, "Skill ID 只允许小写字母、数字、点、横线和下划线");
export const versionLabelSchema = z.string().regex(/^v[1-9]\d*$/, "版本必须使用 v1、v2 等格式");
export const sourceTypes = ["MANUAL", "COPY", "PROJECT_DERIVED", "REVERSE_PROMPT"] as const;
export const sourceTypeSchema = z.enum(sourceTypes);
const line = z.string().trim().max(2000);
const lines = z.array(line).max(100);
export const genericTemplate = z.object({
  purpose: z.string().trim().max(4000), inputs: lines, rules: lines,
  outputRequirements: lines, prohibitions: lines, applicableScenes: lines, tags: lines,
}).strict();
export const imagePromptTemplate = genericTemplate.extend({
  subject: line, composition: line, cameraLens: line, lighting: line, color: line,
  material: line, spatialRelationship: line, style: line, detailDensity: line,
  background: line, motion: line, negativeConstraints: line,
}).strict();
export type SkillContent = z.infer<typeof genericTemplate> | z.infer<typeof imagePromptTemplate>;
export const templateIds = { GENERIC: "generic.v1", IMAGE_PROMPT: "image-prompt.v1" } as const;
export function templateFor(type: SkillType) { return type === "IMAGE_PROMPT" ? templateIds.IMAGE_PROMPT : templateIds.GENERIC; }
export function emptyTemplate(type: SkillType): SkillContent {
  const base = { purpose: "", inputs: [], rules: [], outputRequirements: [], prohibitions: [], applicableScenes: [], tags: [] };
  return type === "IMAGE_PROMPT" ? { ...base, subject: "", composition: "", cameraLens: "", lighting: "", color: "", material: "", spatialRelationship: "", style: "", detailDensity: "", background: "", motion: "", negativeConstraints: "" } : base;
}
export function validateContent(type: SkillType, templateId: string, value: unknown): SkillContent {
  if (templateId !== templateFor(type)) throw new SkillError("SKILL_TEMPLATE_INVALID", "Skill Type 与 Template 不匹配");
  try { return (type === "IMAGE_PROMPT" ? imagePromptTemplate : genericTemplate).parse(value); }
  catch { throw new SkillError("SKILL_TEMPLATE_INVALID", "Skill 结构不符合模板"); }
}
export function definitionHash(templateId: string, content: SkillContent) {
  return createHash("sha256").update(JSON.stringify({ templateId, content })).digest("hex");
}
export function sourceHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function versionNumber(label: unknown) {
  try { return Number(versionLabelSchema.parse(label).slice(1)); }
  catch { throw new SkillError("SKILL_VERSION_NOT_FOUND", "请使用 v1、v2 等精确版本", 404); }
}
export function versionLabel(value: number) { return `v${value}`; }
export class SkillError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function canonicalScopeKey(type: ScopeType, key: string) {
  const patterns: Record<ScopeType, RegExp> = {
    SYSTEM: /^system$/,
    PROFILE: /^profile:[a-z][a-z0-9_-]*$/,
    RECIPE: /^recipe:[a-z][a-z0-9_-]*$/,
    PROJECT: /^project:[1-9]\d*$/,
    STAGE: /^project:[1-9]\d*:script:[1-9]\d*:stage:[a-z][a-z0-9_-]*$/,
    SHOT: /^project:[1-9]\d*:script:[1-9]\d*:storyboard:[1-9]\d*$/,
  };
  if (!patterns[type].test(key) || key.length > 256) throw new SkillError("SKILL_BINDING_INVALID", "Scope Key 不符合规范");
  return key;
}
export function renderRuntimeInstruction(type: SkillType, content: SkillContent) {
  const sections: string[] = [`Skill Type: ${type}`, `Purpose: ${content.purpose}`];
  for (const field of ["inputs", "rules", "outputRequirements", "prohibitions", "applicableScenes", "tags"] as const) {
    if (content[field].length) sections.push(`${field}:\n${content[field].map(value => `- ${value}`).join("\n")}`);
  }
  if (type === "IMAGE_PROMPT") for (const field of ["subject", "composition", "cameraLens", "lighting", "color", "material", "spatialRelationship", "style", "detailDensity", "background", "motion", "negativeConstraints"] as const) {
    const value = (content as z.infer<typeof imagePromptTemplate>)[field];
    if (value) sections.push(`${field}: ${value}`);
  }
  return sections.join("\n\n");
}

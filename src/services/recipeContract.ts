import { createHash } from "node:crypto";
import { z } from "zod";
import { profileKeySchema, stageKeySchema } from "./orchestrator/profileDefinition";
import { skillIdSchema, skillTypeSchema } from "./skillContract";
import { capabilityIdSchema } from "./capabilityContract";

export class RecipeError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const recipeKeySchema = z.string().trim().min(3).max(160).regex(/^[a-z][a-z0-9._-]*$/);
export const recipeVersionSchema = z.string().regex(/^v[1-9]\d*$/);
export function recipeVersionNumber(value: unknown) {
  const result = recipeVersionSchema.safeParse(value);
  if (!result.success || !Number.isSafeInteger(Number(result.data.slice(1)))) throw new RecipeError("RECIPE_VERSION_NOT_FOUND", "请指定精确 Recipe 版本，例如 v1");
  return Number(result.data.slice(1));
}
export const recipeVersionLabel = (version: number) => `v${version}`;
const exactVersion = z.string().regex(/^v[1-9]\d*$/);
export const recipeDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  profileRef: z.object({ profileKey: profileKeySchema, profileVersion: exactVersion }).strict(),
  skillRefs: z.array(z.object({ skillType: skillTypeSchema, skillId: skillIdSchema, skillVersion: exactVersion }).strict()).max(50),
  capabilityRefs: z.array(z.object({ roleKey: z.string().regex(/^[a-z][a-z0-9._-]*$/).max(160), stageKey: stageKeySchema.optional(), capabilityId: capabilityIdSchema }).strict()).max(100),
  assetPlanTemplate: z.array(z.object({ assetKey: z.string().regex(/^[a-z][a-z0-9._-]*$/).max(160), name: z.string().trim().min(1).max(256), category: z.string().trim().min(1).max(100), required: z.boolean(), sourcePolicy: z.enum(["REAL_REQUIRED", "AI_ALLOWED"]) }).strict()).max(200),
  notes: z.array(z.string().trim().max(2000)).max(100),
}).strict();
export type RecipeDefinition = z.infer<typeof recipeDefinitionSchema>;
export function validateRecipeDefinition(value: unknown): RecipeDefinition {
  const result = recipeDefinitionSchema.safeParse(value);
  if (!result.success) throw new RecipeError("RECIPE_DEFINITION_INVALID", "Recipe 定义字段或类型不合法");
  const d = result.data;
  for (const values of [d.skillRefs.map(x => x.skillType), d.capabilityRefs.map(x => x.roleKey), d.assetPlanTemplate.map(x => x.assetKey)]) {
    if (new Set(values).size !== values.length) throw new RecipeError("RECIPE_DEFINITION_INVALID", "Recipe 中 Skill Type、Capability Role 或 Asset Key 重复");
  }
  return d;
}
export function recipeHash(definition: RecipeDefinition) { return createHash("sha256").update(JSON.stringify(definition)).digest("hex"); }

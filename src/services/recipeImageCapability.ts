import type { Knex } from "knex";
import { capabilityIdSchema, definitionHash, validateDefinition } from "./capabilityContract";
import { decodeVersion, versionFields } from "./capabilityRegistry";
import type { readExactRecipeRuntimeContext } from "./recipeRegistry";
import { ProductionGateError } from "./advertisementGate";

type RecipeContext = Awaited<ReturnType<typeof readExactRecipeRuntimeContext>>;
const builtin = "toonflow.image.v1";
type ImageCapabilitySelection = { capabilityId: string | null; resolvedFrom: "SHOT" | "RECIPE" | "BUILTIN" };

export function resolveEffectiveImageCapability(explicitId: string | null, mode: string | null,
  recipe: Pick<NonNullable<RecipeContext>, "capabilityRefs"> | null): ImageCapabilitySelection {
  if (mode !== "AI_TEXT_TO_IMAGE") return { capabilityId: explicitId, resolvedFrom: explicitId ? "SHOT" : "BUILTIN" };
  if (explicitId) return { capabilityId: explicitId, resolvedFrom: "SHOT" };
  const ref = recipe?.capabilityRefs.find(item => item.roleKey === "storyboard-image.text-to-image" &&
    (!item.stageKey || item.stageKey === "image-production"));
  return ref ? { capabilityId: ref.capabilityId, resolvedFrom: "RECIPE" }
    : { capabilityId: builtin, resolvedFrom: "BUILTIN" };
}

// Called only by the B2 pre-write prepareProducer hook, never by the Source
// builder or a historical freshness read. Availability is not Source identity.
export async function validateSelectedImageCapability(q: Knex.Transaction, selection: ImageCapabilitySelection) {
  const { capabilityId, resolvedFrom } = selection;
  if (capabilityId === builtin && resolvedFrom !== "RECIPE") return;
  if (!capabilityIdSchema.safeParse(capabilityId).success)
    throw new ProductionGateError("Capability ID 不合法或不存在", "CAPABILITY_NOT_FOUND", 409);
  const row = await q("o_capabilityVersion").where({ capabilityId }).first();
  if (!row) throw new ProductionGateError("Capability 不存在", "CAPABILITY_NOT_FOUND", 409);
  if (row.status === "DISABLED") throw new ProductionGateError("Capability 已停用", "CAPABILITY_DISABLED", 409);
  if (row.status !== "VERIFIED") throw new ProductionGateError("Capability 尚未验证", "CAPABILITY_NOT_VERIFIED", 409);
  try {
    const decoded = decodeVersion(row)!;
    const valid = validateDefinition(Object.fromEntries(versionFields.map(field => [field, decoded[field]])));
    if (definitionHash(valid) !== definitionHash(decoded)) throw new Error("definition mismatch");
  } catch {
    throw new ProductionGateError("Capability 定义无效", "CAPABILITY_NOT_VERIFIED", 409);
  }
  // The generic Comfy/role adapter is deliberately outside D-C.
  throw new ProductionGateError("当前图片生产器尚不支持该 Capability", "CAPABILITY_NOT_IMPLEMENTED", 409);
}

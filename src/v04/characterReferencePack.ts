import { z } from "zod";

export const CHARACTER_REFERENCE_PACK_V1 = "CHARACTER_REFERENCE_PACK_V1";
export const referencePurposes = ["FACE_HERO", "FULL_BODY_FRONT", "FULL_BODY_BACK",
  "SIDE_SPECIAL_LEFT", "SIDE_SPECIAL_RIGHT", "DETAIL_REFERENCE"] as const;
export const executionPurposes = ["SUBJECT_MAIN_PREVIEW", ...referencePurposes] as const;
export type ExecutionPurpose = typeof executionPurposes[number];
export type ReferencePurpose = typeof referencePurposes[number];
export const referencePlanSchema = z.object({
  required: z.array(z.enum(referencePurposes)).max(6),
  recommended: z.array(z.enum(referencePurposes)).max(6),
  optional: z.array(z.enum(referencePurposes)).max(6),
  sideReferencePolicy: z.literal("ONLY_IF_INFORMATION_GAIN"),
}).strict().refine(plan => {
  const all = [...plan.required, ...plan.recommended, ...plan.optional];
  return new Set(all).size === all.length;
}, "Reference purposes must not be duplicated");

export function resolveCharacterReferencePlan(spec: { referencePlan?: z.infer<typeof referencePlanSchema> }) {
  return referencePlanSchema.parse(spec.referencePlan ?? {
    required: ["FACE_HERO", "FULL_BODY_FRONT"], recommended: ["FULL_BODY_BACK"],
    optional: ["SIDE_SPECIAL_LEFT", "SIDE_SPECIAL_RIGHT", "DETAIL_REFERENCE"],
    sideReferencePolicy: "ONLY_IF_INFORMATION_GAIN",
  });
}
export function deriveCharacterReferenceIntent(spec: Parameters<typeof resolveCharacterReferencePlan>[0]) {
  const plan = resolveCharacterReferencePlan(spec), roles = [...plan.required, ...plan.recommended, ...plan.optional];
  const authority = (role: ReferencePurpose) => roles.includes(role) ? role : null;
  return { identityAuthority: authority("FACE_HERO"), bodyAuthority: authority("FULL_BODY_FRONT"),
    rearAuthority: authority("FULL_BODY_BACK"), leftSideAuthority: authority("SIDE_SPECIAL_LEFT"),
    rightSideAuthority: authority("SIDE_SPECIAL_RIGHT"), detailAuthorities: roles.includes("DETAIL_REFERENCE") ? ["DETAIL_REFERENCE"] : [] };
}

// Recommendation only: callers supply available references, never promote drafts to truth.
export function resolveCharacterReferencesForShot<T extends { role: ReferencePurpose }>(
  shot: { framing: "CLOSE_UP" | "MEDIUM" | "FULL_BODY"; view: "FRONT" | "BACK" | "LEFT" | "RIGHT"; detail?: boolean },
  available: T[], maxCharacterReferences = 2,
) {
  let roles: ReferencePurpose[];
  if (shot.view === "BACK") roles = ["FULL_BODY_BACK"];
  else if (shot.view === "LEFT" || shot.view === "RIGHT") {
    const side = shot.view === "LEFT" ? "SIDE_SPECIAL_LEFT" : "SIDE_SPECIAL_RIGHT";
    roles = available.some(ref => ref.role === side) ? [side, "FACE_HERO"] : ["FACE_HERO", "FULL_BODY_FRONT"];
  } else roles = shot.framing === "CLOSE_UP" ? ["FACE_HERO"] : shot.framing === "FULL_BODY"
    ? ["FULL_BODY_FRONT", "FACE_HERO"] : ["FACE_HERO", "FULL_BODY_FRONT"];
  if (shot.detail) roles = ["DETAIL_REFERENCE", ...roles];
  return roles.flatMap(role => { const ref = available.find(item => item.role === role); return ref ? [ref] : []; })
    .slice(0, Math.max(0, Math.min(6, Math.floor(maxCharacterReferences))));
}

export function characterReferenceExecutionPrompt(ir: any, purpose: ExecutionPurpose) {
  const composition: Record<ExecutionPurpose, string> = {
    SUBJECT_MAIN_PREVIEW: "single character main design preview, full body front, head and feet visible",
    FACE_HERO: "single character chest-up face hero portrait, frontal face, eyes and facial identity clearly readable",
    FULL_BODY_FRONT: "single character full body, strictly facing the camera, head and both feet visible",
    FULL_BODY_BACK: "single character full body, strictly back to camera, rear hair and clothing readable, head and both feet visible",
    SIDE_SPECIAL_LEFT: "single character full body, strict left 90-degree profile, head and both feet visible",
    SIDE_SPECIAL_RIGHT: "single character full body, strict right 90-degree profile, head and both feet visible",
    DETAIL_REFERENCE: "single character detail reference, preserve exact identity and specified clothing details",
  };
  return [ir.identityBlock.name, ir.identityBlock.visualIdentitySummary,
    JSON.stringify(ir.appearanceBlock.details), ...ir.materialBlock.primaryPalette,
    ...ir.positiveConstraints, composition[purpose], "Neutral clean background; one view only, not a multi-view sheet; no redesign or extra accessories."].filter(Boolean).join("; ");
}

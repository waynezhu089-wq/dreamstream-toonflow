import type { Knex } from "knex";
import u from "@/utils";
import { advertisementV1, definitionHash, ProfileError, validateDefinition, type ProfileDefinition } from "./profileDefinition";
import { resolveProfile } from "./profileRegistry";
import { readProductionOperationAdmission } from "./productionOperationGuard";
import type { ProductionOperationKey } from "./productionOperationRegistry";

export const PRE_001E_PROFILE_HASHES = new Set([
  "d9dc75286b4bf496a4ea3f7b6c3e453a1b59d7fa9aa33b4edaf4dc75223aadae",
  "2d827d74c35bca596fe330986c9b06b70b2d18e61a6a9cbc3635c96545eeb1e3",
] as const);
export const E001_PROFILE_HASH = "82d3ac725a9f89dee7ba556068408bc0cad89dba6e400974c574af3111be4521";

const imageOps = ["storyboard.image.generate", "storyboard.image.composite", "storyboard.image.attach"];
export const videoOperationKeys = [
  "video.prompt.generate",
  "video.source.update",
  "video.generate",
  "video.accept",
  "video.candidate.retire",
] as const;

function advertisementV2(supervisorGate: string, withVideo: boolean): ProfileDefinition {
  return validateDefinition({
    schemaVersion: 2,
    runtimeControl: "ENFORCED",
    initialStageKey: advertisementV1.initialStageKey,
    transitions: advertisementV1.transitions,
    stages: advertisementV1.stages.map(stage => ({
      ...stage,
      exitGateKey: stage.stageKey === "supervisor-review" ? supervisorGate :
        stage.stageKey === "video-production" && withVideo ? "video.accepted-current-ready" : stage.exitGateKey,
      operationKeys: stage.stageKey === "image-production" ? imageOps :
        stage.stageKey === "video-production" && withVideo ? [...videoOperationKeys] : [],
    })),
  });
}

export const advertisementPreE001DA = advertisementV2("supervisor.storyboard-approved", false);
export const advertisementPreE001SemanticV2 = advertisementV2("supervisor.storyboard-approved.v2", false);
export const advertisement001eDefinition = advertisementV2("supervisor.storyboard-approved.v2", true);

for (const [definition, expected] of [
  [advertisementPreE001DA, "d9dc75286b4bf496a4ea3f7b6c3e453a1b59d7fa9aa33b4edaf4dc75223aadae"],
  [advertisementPreE001SemanticV2, "2d827d74c35bca596fe330986c9b06b70b2d18e61a6a9cbc3635c96545eeb1e3"],
  [advertisement001eDefinition, E001_PROFILE_HASH],
] as const) {
  if (definitionHash(definition) !== expected) throw new Error("Frozen 001E Profile hash mismatch");
}

export type VideoProfileClass = "LEGACY" | "PRE_001E_CONTROLLED_COMPAT" | "E001_ENABLED" | "MANAGED_V2_UNSUPPORTED";

export async function classifyVideoProfile(q: Knex | Knex.Transaction = u.db as Knex, projectId: number): Promise<VideoProfileClass> {
  const profile = await resolveProfile({ projectId }, q);
  if (!profile.managed || profile.definition.schemaVersion === 1) return "LEGACY";
  if (profile.profileKey !== "advertisement") return "MANAGED_V2_UNSUPPORTED";
  const hash = definitionHash(profile.definition);
  if (PRE_001E_PROFILE_HASHES.has(hash as any)) return "PRE_001E_CONTROLLED_COMPAT";
  if (hash === E001_PROFILE_HASH) return "E001_ENABLED";
  return "MANAGED_V2_UNSUPPORTED";
}

export async function videoProfileClassForProject(projectId: number) {
  return (u.db as Knex).transaction(q => classifyVideoProfile(q, projectId));
}

export async function assertVideoOperationAllowedInTransaction(q: Knex.Transaction, operationKey: ProductionOperationKey,
  scope: { projectId: number; scriptId: number }) {
  const profileClass = await classifyVideoProfile(q, scope.projectId);
  if (profileClass === "MANAGED_V2_UNSUPPORTED") {
    throw new ProfileError("VIDEO_PROFILE_COMPAT_UNSUPPORTED", "当前受控 Profile 未声明受支持的视频生产合同", 409);
  }
  if (profileClass !== "E001_ENABLED") return profileClass;
  const admission = await readProductionOperationAdmission(operationKey, scope, q);
  if (!admission.enforced || !admission.snapshotConsistent || !admission.allowed ||
    admission.profileDefinitionHash !== E001_PROFILE_HASH) {
    throw new ProfileError(admission.code || "VIDEO_PROFILE_COMPAT_UNSUPPORTED",
      admission.reason || "当前视频生产工序尚未放行", admission.code === "PRODUCTION_CONTROL_UNAVAILABLE" ? 503 : 409);
  }
  return profileClass;
}

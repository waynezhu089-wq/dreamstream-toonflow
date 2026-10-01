import type { Knex } from "knex";
import u from "@/utils";
import { capabilityIdSchema } from "./capabilityContract";
import { decodeVersion } from "./capabilityRegistry";
import { ProductionGateError } from "./advertisementGate";
import { acquireRevisionBoundary } from "./orchestrator/revisionBoundary";
import { isControlledSemanticV2 } from "./orchestrator/revisionWriteSafety";
import { validateImageRole } from "./storyboardImageCapability";
import { productionSpec } from "./storyboardProduction";

const reject = (code: string, message: string, status = 409): never => { throw new ProductionGateError(message, code, status); };

// Execution selection only. Semantic writes continue to use Revision Confirm.
export async function setShotCapabilityOverride(input: {
  projectId: number; scriptId: number; storyboardId: number; capabilityId: string | null;
}, actorUserId: unknown) {
  return (u.db as Knex).transaction(async trx => {
    const owner = process.env.DS_STUDIO_OWNER_USER_ID;
    const actor = typeof actorUserId === "number" ? actorUserId : Number(actorUserId);
    if (!owner || !/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner)) ||
      !Number.isSafeInteger(actor) || actor !== Number(owner) ||
      !await trx("o_user").where({ id: actor }).first("id"))
      reject("SHOT_CAPABILITY_ACCESS_DENIED", "当前账号无权设置镜头 Capability", 403);
    await acquireRevisionBoundary(trx, input.projectId, input.scriptId);
    if (!await isControlledSemanticV2(trx, input.projectId, input.scriptId))
      reject("SHOT_CAPABILITY_SCOPE_INVALID", "仅受控 V2 分镜可设置镜头 Capability");
    const shot = await trx("o_storyboard").where({ id: input.storyboardId, projectId: input.projectId,
      scriptId: input.scriptId }).whereNull("retiredAt").first();
    if (!shot) reject("STORYBOARD_SCOPE_INVALID", "分镜不存在、不属于当前制作单元或已退休");
    const spec = productionSpec(shot);
    if (spec.productionMode !== "AI_TEXT_TO_IMAGE")
      reject("CAPABILITY_ROLE_INCOMPATIBLE", "当前镜头不是 AI 文生图模式");
    if (input.capabilityId !== null) {
      if (!capabilityIdSchema.safeParse(input.capabilityId).success)
        reject("CAPABILITY_NOT_FOUND", "Capability ID 不合法");
      const row = await trx("o_capabilityVersion").where({ capabilityId: input.capabilityId }).first();
      if (!row) reject("CAPABILITY_NOT_FOUND", "Capability 精确版本不存在");
      if (row.status === "DISABLED") reject("CAPABILITY_DISABLED", "Capability 已停用");
      if (row.status !== "VERIFIED") reject("CAPABILITY_NOT_VERIFIED", "Capability 尚未验证");
      validateImageRole(decodeVersion(row));
    }
    if (spec.capabilityId !== input.capabilityId) {
      // Keep every existing semantic and execution field byte-for-byte; change only this key.
      const raw = shot.productionSpec ? JSON.parse(shot.productionSpec) : {};
      await trx("o_storyboard").where({ id: input.storyboardId, projectId: input.projectId,
        scriptId: input.scriptId }).whereNull("retiredAt")
        .update({ productionSpec: JSON.stringify({ ...raw, capabilityId: input.capabilityId }) });
    }
    return { projectId: input.projectId, scriptId: input.scriptId, storyboardId: input.storyboardId,
      capabilityId: input.capabilityId };
  });
}

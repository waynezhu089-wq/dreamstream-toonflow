import u from "@/utils";
import { resolveProductionProfile } from "@/agents/productionAgent/profile";

export const STATE_KEY = "advertisement:asset-preparation";

export class ProductionGateError extends Error {
  constructor(message: string, public code = "PRODUCTION_CONTEXT_INVALID", public status = 400) {
    super(message);
  }
}

export function productionId(value: unknown): number {
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new ProductionGateError("请提供有效的项目和当前制作单元 ID");
  }
  return number;
}

export function gateFailure(error: unknown) {
  const known = error instanceof ProductionGateError;
  return {
    success: false as const,
    code: known ? error.code : "PRODUCTION_GATE_UNAVAILABLE",
    message: known ? error.message : "暂时无法校验广告资产门禁，请稍后重试",
    status: known ? error.status : 503,
  };
}

// Optional scriptId is only for older status/confirmation clients. Production
// entry points use assertProductionReady and never fall back to the first unit.
export async function readState(projectId: number, scriptId?: number) {
  projectId = productionId(projectId);
  const project = await u.db("o_project").where("id", projectId).first();
  if (!project) throw new ProductionGateError("项目不存在", "PRODUCTION_CONTEXT_INVALID", 404);
  if (resolveProductionProfile(project).key !== "advertisement") {
    throw new ProductionGateError("当前项目不是广告视频项目");
  }
  const scripts = u.db("o_script").where("projectId", projectId);
  const script = scriptId === undefined
    ? await scripts.orderBy("createTime", "asc").first()
    : await scripts.where("id", productionId(scriptId)).first();
  if (!script?.id) throw new ProductionGateError("当前广告制作单元不存在或不属于该项目");

  const assets = await u
    .db("o_scriptAssets")
    .join("o_assets", "o_scriptAssets.assetId", "o_assets.id")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .where("o_scriptAssets.scriptId", script.id)
    .where("o_assets.projectId", projectId)
    .whereNull("o_assets.assetsId")
    .select("o_assets.id", "o_assets.name", "o_assets.type", "o_assets.imageId", "o_image.state as imageState", "o_image.filePath as filePath");
  const incompleteAssets = assets
    .filter((item) => !item.imageId || item.imageState !== "已完成" || !item.filePath)
    .map((item) => ({ id: item.id, name: item.name, type: item.type, state: item.imageState ?? "未生成" }));
  const stateRow = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: script.id, key: STATE_KEY })
    .orderBy("updateTime", "desc")
    .first();
  let confirmed = false;
  if (stateRow?.data) {
    try { confirmed = JSON.parse(stateRow.data).confirmed === true; } catch {}
  }
  return {
    projectId, scriptId: script.id,
    assetCount: assets.length, readyAssetCount: assets.length - incompleteAssets.length,
    incompleteAssets, confirmed,
    ready: confirmed && assets.length > 0 && incompleteAssets.length === 0,
  };
}

export async function assertProductionReady(projectId: unknown, scriptId: unknown) {
  try {
    await checkProductionReady(projectId, scriptId);
  } catch (error) {
    if (error instanceof ProductionGateError) throw error;
    const failure = gateFailure(error);
    throw new ProductionGateError(failure.message, failure.code, failure.status);
  }
}

async function checkProductionReady(projectId: unknown, scriptId: unknown) {
  const project = await u.db("o_project").where("id", productionId(projectId)).first();
  if (!project) throw new ProductionGateError("项目不存在", "PRODUCTION_CONTEXT_INVALID", 404);
  // Non-advertisement entry points do not acquire an advertisement Gate.
  if (resolveProductionProfile(project).key !== "advertisement") {
    if (scriptId !== undefined) {
      const script = await u.db("o_script").where({ id: productionId(scriptId), projectId: project.id }).first();
      if (!script) throw new ProductionGateError("当前制作单元不存在或不属于该项目");
    }
    return;
  }
  const state = await readState(project.id!, productionId(scriptId));
  if (!state.ready) {
    throw new ProductionGateError("当前制作单元的广告资产尚未准备并确认完成，请先完成资产准备", "ADVERTISEMENT_ASSET_GATE_BLOCKED", 409);
  }
}

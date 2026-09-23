import u from "@/utils";
import { readAssetPlanInTransaction } from "@/services/advertisementAssetPlan";
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

// Every caller must identify the current unit; no first-unit fallback.
// Read plan, current bindings/images and confirmation in one SQLite snapshot.
export async function readState(projectId: number, scriptId: number) {
  projectId = productionId(projectId);
  scriptId = productionId(scriptId);
  return u.db.transaction(async (trx) => {
    const project = await trx("o_project").where("id", projectId).first();
    if (!project) throw new ProductionGateError("项目不存在", "PRODUCTION_CONTEXT_INVALID", 404);
    if (resolveProductionProfile(project).key !== "advertisement") {
      throw new ProductionGateError("当前项目不是广告视频项目");
    }
    const script = await trx("o_script").where({ id: scriptId, projectId }).first();
    if (!script) throw new ProductionGateError("当前广告制作单元不存在或不属于该项目");
    const plan = await readAssetPlanInTransaction(trx, { projectId, scriptId });
    const planItems = [];
    for (const item of plan.items) {
      const asset = item.bindingValid ? await trx("o_assets").where({ id: item.assetId, projectId }).first() : undefined;
      const image = asset?.imageId == null ? undefined : await trx("o_image").where({ id: asset.imageId, assetsId: asset.id }).first();
      const imageReady = image?.state === "已完成" && typeof image.filePath === "string" && image.filePath.trim().length > 0;
      const issue = item.bindingIssue ?? (imageReady ? null : "ASSET_PLAN_IMAGE_INCOMPLETE");
      planItems.push({ ...item, ready: issue === null, issue, imageState: image?.state ?? "未生成" });
    }
    const incompleteAssets = planItems.filter(item => item.required && !item.ready).map(item => ({
      id: item.assetId, assetKey: item.assetKey, name: item.name, type: item.category, state: item.imageState, reason: item.issue,
    }));
    const prepared = planItems.length > 0 && incompleteAssets.length === 0;
    const stateRow = await trx("o_agentWorkData")
      .where({ projectId, episodesId: scriptId, key: STATE_KEY }).orderBy("updateTime", "desc").first();
    let confirmed = false;
    if (stateRow?.data) {
      try { confirmed = JSON.parse(stateRow.data).confirmed === true; } catch {}
    }
    return {
      projectId, scriptId, assetCount: planItems.length,
      readyAssetCount: planItems.filter(item => item.ready).length,
      requiredAssetCount: planItems.filter(item => item.required).length,
      planItems, incompleteAssets, prepared, confirmed,
      ready: confirmed && prepared,
    };
  });
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

import type { Express, RequestHandler } from "express";
import u from "@/utils";
import { assertProductionReady, gateFailure, productionId, ProductionGateError } from "@/services/advertisementGate";
import { operationForProductionRoute } from "@/services/orchestrator/productionOperationRegistry";
import { assertProductionOperationAllowed } from "@/services/orchestrator/productionOperationGuard";
import workflowState from "@/routes/project/advertisement/getWorkflowState";
import confirmAssets from "@/routes/project/advertisement/confirmAssetPreparation";

// Reads do not start production or change its state. Asset preparation remains
// available under /api/assets*, outside this downstream production boundary.
const readOnly = new Set([
  "/getstoryboarddata", "/assets/pollingimage", "/editimage/getimagedefaultmodle", "/editimage/getimageflow",
  "/storyboard/composite/read",
  "/storyboard/getstoryboarddata", "/storyboard/pollingimage", "/storyboard/downpreviewimage", "/storyboard/previewimage",
  "/workbench/checkvideoprompt", "/workbench/checkvideostatelist", "/workbench/getaudiobindassetslist",
  "/workbench/getfileurl", "/workbench/getgeneratedata", "/workbench/getvideolist",
]);

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) throw new ProductionGateError("缺少操作对象 ID 列表");
  return [...new Set(value.map(productionId))];
}

export const productionGate: RequestHandler = async (req, res, next) => {
  // Express routes are case-insensitive and allow a trailing slash by default.
  const route = req.path.toLowerCase().replace(/\/+$/, "");
  if (readOnly.has(route)) return next();
  const body = req.body ?? {};
  const scopes = new Map<string, { projectId: number; scriptId: number }>();
  try {
    const requestedProject = body.projectId === undefined ? undefined : productionId(body.projectId);
    const requestedScript = body.scriptId === undefined && body.episodesId === undefined
      ? undefined : productionId(body.scriptId ?? body.episodesId);
    if (body.scriptId !== undefined && body.episodesId !== undefined && productionId(body.episodesId) !== requestedScript) {
      throw new ProductionGateError("制作单元参数不一致");
    }
    async function addScript(value: unknown, owner?: unknown) {
      const scriptId = productionId(value);
      const script = await u.db("o_script").where("id", scriptId).first();
      if (!script) throw new ProductionGateError("操作对象的制作单元不存在");
      const projectId = productionId(script.projectId);
      if ((owner != null && productionId(owner) !== projectId) ||
          (requestedProject !== undefined && requestedProject !== projectId) ||
          (requestedScript !== undefined && requestedScript !== scriptId)) {
        throw new ProductionGateError("操作对象不属于当前项目或制作单元");
      }
      scopes.set(`${projectId}:${scriptId}`, { projectId, scriptId });
    }
    async function records(table: "o_storyboard" | "o_videoTrack" | "o_video", values: unknown) {
      const selected = ids(values);
      const rows = await u.db(table).whereIn("id", selected).select("id", "projectId", "scriptId");
      if (rows.length !== selected.length) throw new ProductionGateError("操作对象不存在");
      for (const row of rows) await addScript(row.scriptId, row.projectId);
    }
    async function assets(values: unknown) {
      const selected = ids(values);
      const rows = await u.db("o_assets").whereIn("id", selected);
      if (rows.length !== selected.length) throw new ProductionGateError("操作资产不存在");
      for (const row of rows) {
        const projectId = productionId(row.projectId);
        if (requestedProject !== undefined && requestedProject !== projectId) throw new ProductionGateError("资产不属于当前项目");
        // Direct links identify a derivative's unit. Parent links are only a
        // fallback for older derivatives which did not have their own link.
        let links = await u.db("o_scriptAssets").where("assetId", row.id).select("scriptId");
        if (!links.length && row.scriptId) links = [{ scriptId: row.scriptId }];
        if (!links.length && row.assetsId) links = await u.db("o_scriptAssets").where("assetId", row.assetsId).select("scriptId");
        if (requestedScript !== undefined) {
          if (!links.some(link => link.scriptId === requestedScript)) throw new ProductionGateError("资产未关联当前制作单元");
          await addScript(requestedScript, projectId);
        } else if (links.length) {
          // ID-only operations must pass every affected unit, never the first.
          for (const link of links) await addScript(link.scriptId, projectId);
        } else {
          await assertProductionReady(projectId, undefined);
        }
      }
    }
    if (requestedScript !== undefined) await addScript(requestedScript, requestedProject);
    switch (route) {
      case "/storyboard/composite/start":
      case "/storyboard/composite/finish":
        if (requestedProject === undefined || requestedScript === undefined) throw new ProductionGateError("缺少当前项目或制作单元");
        await records("o_storyboard", [body.storyboardId]);
        break;
      case "/getflowdata":
      case "/saveflowdata":
      case "/storyboard/addstoryboard":
      case "/storyboard/batchaddstoryboardinfo":
      case "/storyboard/replacestoryboard":
      case "/workbench/addtrack":
      case "/editimage/uploadimage":
        if (requestedScript === undefined || requestedProject === undefined) throw new ProductionGateError("缺少当前项目或制作单元");
        if (route === "/saveflowdata" && Array.isArray(body.data?.storyboard)) {
          await records("o_storyboard", body.data.storyboard.filter((item: any) => item.id).map((item: any) => item.id));
        }
        break;
      case "/storyboard/batchgenerateimage":
        await records("o_storyboard", body.storyboardIds);
        break;
      case "/storyboard/batchdelete":
        await records("o_storyboard", body.ids);
        break;
      case "/storyboard/editstoryboardinfo":
      case "/storyboard/removeframe":
      case "/storyboard/updatestoryboardurl":
        await records("o_storyboard", [body.id]);
        break;
      case "/workbench/generatevideo":
      case "/workbench/generatevideoprompt":
        await records("o_videoTrack", [body.trackId]);
        break;
      case "/workbench/batchgeneratevideo":
      case "/workbench/batchgenerateprompt":
        if (!Array.isArray(body.trackData)) throw new ProductionGateError("缺少视频轨道列表");
        await records("o_videoTrack", body.trackData.map((item: any) => item.trackId));
        break;
      case "/workbench/deletetrack":
      case "/workbench/updatevideoduration":
      case "/workbench/updatevideoprompt":
        await records("o_videoTrack", [body.id]);
        break;
      case "/workbench/delvideo":
        await records("o_video", [body.id]);
        break;
      case "/workbench/selectvideo":
        await records("o_videoTrack", [body.trackId]);
        await records("o_video", [body.videoId]);
        break;
      case "/assets/batchgenerateassetsimage":
        await assets(body.assetIds);
        break;
      case "/assets/deleteassetsdireve":
      case "/assets/updateassetsurl":
        await assets([body.id]);
        break;
      case "/editimage/generateflowimage":
        // Older callers send projectId only. Advertisement generation must now
        // supply scriptId; never infer it from another unit's confirmation.
        await assertProductionReady(requestedProject, requestedScript);
        break;
      case "/editimage/updateimageflow": {
        const flowId = productionId(body.flowId);
        const linkedShots = await u.db("o_storyboard").where("flowId", flowId).select("id");
        const linkedAssets = await u.db("o_assets").where("flowId", flowId).select("id");
        await records("o_storyboard", linkedShots.map(row => row.id));
        await assets(linkedAssets.map(row => row.id));
        break;
      }
      case "/editimage/saveimageflow":
        // An unbound editor draft cannot start generation or alter a production
        // unit. Generation, attaching it, and editing a bound flow are guarded.
        break;
      default:
        throw new ProductionGateError("未识别的 Production 操作，无法校验资产门禁");
    }
    for (const scope of scopes.values()) await assertProductionReady(scope.projectId, scope.scriptId);
    if (!scopes.size && requestedProject !== undefined) await assertProductionReady(requestedProject, requestedScript);
    const operationKey = operationForProductionRoute(route);
    if (operationKey) {
      if (!scopes.size) throw new ProductionGateError("无法确定生产操作的当前制作单元", "PRODUCTION_CONTEXT_INVALID", 400);
      for (const scope of scopes.values()) await assertProductionOperationAllowed(operationKey, scope);
    }
    next();
  } catch (error) {
    const failure = gateFailure(error);
    res.status(failure.status).send({ code: failure.status, message: failure.message, data: failure });
  }
};

export function registerProductionGate(app: Express) {
  // Register explicitly for production builds too; dev's generated router may
  // contain these routes, but older checked-in router.ts snapshots do not.
  app.use("/api/project/advertisement/getWorkflowState", workflowState);
  app.use("/api/project/advertisement/confirmAssetPreparation", confirmAssets);
  app.use("/api/production", productionGate);
}

import express from "express";
import { success } from "@/lib/responseFormat";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
import { actOnStage, readOrchestrator, stageEvents } from "@/services/orchestrator/stageOrchestrator";
import { previewRevision } from "@/services/orchestrator/revisionPreview";
import { confirmRevision, readRevisionHistory } from "@/services/orchestrator/revisionConfirm";
import { fenceRevisionWork } from "@/services/orchestrator/revisionWorkGuard";
import { z } from "zod";

const router = express.Router();
function route(path: string, action: (body: any) => Promise<any>) {
  router.post(path, async (req, res) => {
    try { res.send(success(await action(req.body ?? {}))); }
    catch (error: any) {
      const status = error instanceof ProfileError ? error.status : 500;
      res.status(status).send({ code: status, message: status === 500 ? "Stage Orchestrator 暂时不可用" : error.message, data: { reason: error instanceof ProfileError ? error.code : "STAGE_GATE_UNAVAILABLE" } });
    }
  });
}
route("/read", readOrchestrator);
route("/start", body => actOnStage("start", body));
route("/complete", body => actOnStage("complete", body));
route("/skip", body => actOnStage("skip", body));
route("/events", stageEvents);
route("/revision/preview", previewRevision);
router.post("/revision/confirm", async (req, res) => {
  try { res.send(success(await confirmRevision(req.body ?? {}, (req as any).user))); }
  catch (error: any) {
    const status = error instanceof ProfileError ? error.status : 500;
    res.status(status).send({ code: status, message: status === 500 ? "Revision Confirm 暂时不可用" : error.message,
      data: { reason: error instanceof ProfileError ? error.code : "REVISION_RUNTIME_UNSAFE" } });
  }
});
router.post("/revision/history", async (req, res) => {
  try { res.send(success(await readRevisionHistory(req.body ?? {}, (req as any).user))); }
  catch (error: any) {
    const status = error instanceof ProfileError ? error.status : 500;
    res.status(status).send({ code: status, message: status === 500 ? "Revision History 暂时不可用" : error.message,
      data: { reason: error instanceof ProfileError ? error.code : "REVISION_RUNTIME_UNSAFE" } });
  }
});
router.post("/revision/workGuard/fence", async (req, res) => {
  try {
    const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
      guardId: z.string().uuid(), reason: z.string().trim().min(1).max(1000) }).strict().parse(req.body);
    res.send(success(await fenceRevisionWork({ projectId: input.projectId, scriptId: input.scriptId },
      input.guardId, (req as any).user, input.reason)));
  } catch (error: any) {
    const status = error instanceof ProfileError ? error.status : 400;
    res.status(status).send({ code: status, message: status === 400 ? "恢复请求字段无效" : error.message,
      data: { reason: error instanceof ProfileError ? error.code : "REVISION_CHANGE_INVALID" } });
  }
});
export default router;

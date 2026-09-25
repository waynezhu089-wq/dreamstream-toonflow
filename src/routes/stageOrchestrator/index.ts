import express from "express";
import { success } from "@/lib/responseFormat";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
import { actOnStage, readOrchestrator, stageEvents } from "@/services/orchestrator/stageOrchestrator";

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
export default router;

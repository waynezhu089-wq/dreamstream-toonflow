import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { SupervisorError } from "@/services/supervisor/contract";
import { decide, gateCheck, reviewHistory, targetRead } from "@/services/supervisor/review";
import { aiContext, reviewAi } from "@/services/supervisor/aiReview";

const router = express.Router();
function route(path: string, action: (body: unknown, user: unknown) => Promise<unknown>) {
  router.post(path, async (req, res) => {
    try { res.send(success(await action(req.body ?? {}, (req as any).user))); }
    catch (error: any) {
      const status = error instanceof SupervisorError ? error.status : error instanceof z.ZodError ? 400 : 500;
      res.status(status).send({ code: status, message: status === 500 ? "Supervisor 服务暂时不可用" : error.message,
        data: { reason: error instanceof SupervisorError ? error.code : "SUPERVISOR_TARGET_UNAVAILABLE" } });
    }
  });
}
route("/target/read", body => targetRead(body));
route("/review/history", body => reviewHistory(body));
route("/review/decide", (body, user) => decide(body, user));
route("/ai/context", body => aiContext(body));
route("/review/ai", body => reviewAi(body));
route("/gate/check", body => gateCheck(body));
export default router;

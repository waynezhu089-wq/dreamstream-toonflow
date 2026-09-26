import express from "express";
import { ZodError } from "zod";
import { CompositeError } from "@/services/compositeGeometry";
import { createCompositeAttempt, runCompositeBackground, readCompositeAttempt, finishCompositeAttempt } from "@/services/compositeAttempt";
const router = express.Router();
for (const action of ["start", "read", "finish"] as const) router.post(`/${action}`, async (req, res) => {
  try {
    let data;
    if (action === "start") {
      data = await createCompositeAttempt(req.body);
      void runCompositeBackground({ projectId: data.projectId, scriptId: data.scriptId, storyboardId: data.storyboardId, attemptId: data.id }).catch(error => console.error("Composite background runner:", error));
    } else data = await (action === "read" ? readCompositeAttempt(req.body) : finishCompositeAttempt(req.body));
    res.send({ code: 200, data });
  } catch (e) {
    const status = e instanceof CompositeError ? e.status : e instanceof ZodError ? 400 : 500;
    res.status(status).send({ code: status, message: e instanceof Error ? e.message : "合成操作失败", data: { reason: e instanceof CompositeError ? e.code : "COMPOSITE_FAILED" } });
  }
});
export default router;

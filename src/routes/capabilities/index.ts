import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { CapabilityError } from "@/services/capabilityContract";
import { createFamily, createVersion, disableVersion, getVersion, listCapabilities, listEndpoints, listExecutions, readExecution, saveEndpoint, updateDraft, updateFamily, verifyVersion } from "@/services/capabilityRegistry";
import { executeCapability, testCapability } from "@/services/executeCapability";

const router = express.Router();
function route(path: string, action: (body: any) => Promise<any>) {
  router.post(path, async (req, res) => {
    try { res.send(success(await action(req.body ?? {}))); }
    catch (e) {
      const status = e instanceof CapabilityError ? e.status : e instanceof z.ZodError ? 400 : 500;
      const code = e instanceof CapabilityError ? e.code : "CAPABILITY_MAPPING_INVALID";
      res.status(status).send({ code: status, message: e instanceof Error ? e.message : "Capability 操作失败", data: { reason: code } });
    }
  });
}
route("/list", async () => listCapabilities());
route("/family/create", createFamily);
route("/family/update", updateFamily);
route("/endpoint/list", async () => listEndpoints());
route("/endpoint/save", saveEndpoint);
route("/version/get", body => getVersion(body.capabilityId));
route("/version/create", createVersion);
route("/version/update", updateDraft);
route("/version/verify", verifyVersion);
route("/version/disable", disableVersion);
route("/version/test", body => testCapability(body.capabilityId, body.inputs));
route("/execute", body => executeCapability(body.capabilityId, body.inputs));
route("/execution/list", listExecutions);
route("/execution/read", readExecution);
export default router;

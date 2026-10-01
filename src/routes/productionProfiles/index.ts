import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { ProfileError } from "@/services/orchestrator/profileDefinition";
import { activateVersion, adoptLegacy, bindProfile, createFamily, createVersion, deprecateVersion, editVersion, getProfile, listProfiles, resolveProfile } from "@/services/orchestrator/profileRegistry";

const router = express.Router();
function route(path: string, action: (body: any) => Promise<any>) {
  router.post(path, async (req, res) => {
    try { res.send(success(await action(req.body ?? {}))); }
    catch (error: any) {
      const status = error instanceof ProfileError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const code = error instanceof ProfileError ? error.code : "PROFILE_DEFINITION_INVALID";
      res.status(status).send({ code: status, message: status === 500 ? "Production Profile 暂时不可用" : error.message, data: { reason: code } });
    }
  });
}
route("/list", listProfiles);
route("/get", getProfile);
route("/family/create", createFamily);
route("/version/create", createVersion);
route("/version/edit", editVersion);
route("/version/activate", activateVersion);
route("/version/deprecate", deprecateVersion);
route("/resolve", resolveProfile);
route("/bind", bindProfile);
route("/adopt-legacy", adoptLegacy);
export default router;

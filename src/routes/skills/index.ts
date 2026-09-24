import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { emptyTemplate, SkillError, skillTypeSchema, templateFor } from "@/services/skillContract";
import { activateDraft, buildFromSelectedSource, checkReversePromptCompatibility, copySkill, createDraft, createSkillFamily, deprecateVersion, editDraft, getSkill, listBindings, listSkills, loadSkill, previewVersion, recommendSkills, removeBinding, requireReversePromptExecution, resolveSkill, saveBinding } from "@/services/skillRegistry";
import { applyCompile, compileImagePrompt, readCompile } from "@/services/skillCompiler";

const router = express.Router();
function route(path: string, action: (body: any) => Promise<any>) {
  router.post(path, async (req, res) => {
    try { res.send(success(await action(req.body ?? {}))); }
    catch (error: any) {
      const status = error instanceof SkillError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const code = error instanceof SkillError ? error.code : error instanceof z.ZodError ? "SKILL_TEMPLATE_INVALID" : "SKILL_COMPILE_FAILED";
      res.status(status).send({ code: status, message: error instanceof z.ZodError ? "Skill 输入不合法" : error?.message ?? "Skill 操作失败", data: { reason: code } });
    }
  });
}
route("/templates", async () => Object.fromEntries(skillTypeSchema.options.map(type => [type, { templateId: templateFor(type), content: emptyTemplate(type) }])));
route("/list", async () => listSkills());
route("/get", getSkill);
route("/family/create", createSkillFamily);
route("/version/create", createDraft);
route("/version/edit", editDraft);
route("/version/activate", activateDraft);
route("/version/deprecate", deprecateVersion);
route("/version/preview", previewVersion);
route("/load", body => loadSkill(body.skillId, body.skillVersion));
route("/binding/save", saveBinding);
route("/binding/remove", removeBinding);
route("/binding/list", listBindings);
route("/resolve", resolveSkill);
route("/recommend", recommendSkills);
route("/builder/copy", copySkill);
route("/builder/project-derived", buildFromSelectedSource);
route("/builder/reverse-compatibility", checkReversePromptCompatibility);
route("/builder/reverse-prompt", requireReversePromptExecution);
route("/compile", compileImagePrompt);
route("/compile/read", readCompile);
route("/compile/apply", applyCompile);
export default router;

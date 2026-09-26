import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { RecipeError } from "@/services/recipeContract";
import { activateRecipeVersion, bindRecipe, createRecipeFamily, createRecipeVersion, deprecateRecipeVersion, editRecipeVersion, getRecipe, listRecipes, previewRecipeBind, resolveRecipe, unbindRecipe } from "@/services/recipeRegistry";

const router = express.Router();
function route(path: string, action: (body: any) => Promise<any>) {
  router.post(path, async (req, res) => {
    try { res.send(success(await action(req.body ?? {}))); }
    catch (error: any) {
      const status = error instanceof RecipeError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const reason = error instanceof RecipeError ? error.code : "RECIPE_DEFINITION_INVALID";
      res.status(status).send({ code: status, message: status === 500 ? "Recipe 服务暂时不可用" : error.message, data: { reason } });
    }
  });
}
route("/list", listRecipes);
route("/get", getRecipe);
route("/family/create", createRecipeFamily);
route("/version/create", createRecipeVersion);
route("/version/edit", editRecipeVersion);
route("/version/activate", activateRecipeVersion);
route("/version/deprecate", deprecateRecipeVersion);
route("/project/resolve", resolveRecipe);
route("/project/preview-bind", previewRecipeBind);
route("/project/bind", bindRecipe);
route("/project/unbind", unbindRecipe);
export default router;

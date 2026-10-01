import fs from "fs/promises";
import path from "path";
import u from "@/utils";
import { settleRevisionWork } from "./revisionWorkGuard";

type Scope = { projectId: number; scriptId: number };
type Guard = { guardId: string; trackId: number; kind: "VIDEO_GENERATE" | "VIDEO_PROMPT"; admittedEpoch: number; videoId: number | null };
type Ref = { id: number; sources: string };

// The durable guard is committed before this producer reads inputs or invokes AI.
// It owns only the eventual track write; a superseded worker can keep its
// provider response but cannot publish it as the current prompt.
export async function runControlledVideoPrompt(scope: Scope, guard: Guard,
  info: Ref[], model: string, mode: string) {
  try {
    const [vendorId, modelId] = model.split(/:(.+)/);
    const project = await u.db("o_project").where({ id: scope.projectId }).first("artStyle");
    const bound = await u.db("o_modelPrompt").where({ vendorId, model: modelId }).first("path");
    let system: string | undefined;
    if (bound?.path) {
      try { system = await fs.readFile(path.join(u.getPath(["modelPrompt"]), bound.path), "utf8"); }
      catch { /* Preserve the existing fallback order. */ }
    }
    if (!system) {
      const lower = (modelId ?? "").toLowerCase();
      let filename: string | null = null;
      if (lower.includes("wan") && lower.includes("2.6")) filename = "wan2.6Single-imageFirstFrameMode.md";
      else if (/seedance.*2[.\-]0/i.test(lower)) filename = "seedance2Multi-parameterMode.md";
      else if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) filename = "universalFirstAndLastFrameMode.md";
      else if (mode.startsWith('["') && mode.endsWith('"]')) filename = "universalMulti-parameterMode.md";
      if (filename) {
        try { system = await fs.readFile(path.join(u.getPath(["modelPrompt"]), "video", filename), "utf8"); }
        catch { /* Use the persisted prompt. */ }
      }
    }
    if (!system) {
      const fallback = await u.db("o_prompt").where({ type: "videoPromptGeneration" }).first("data", "useData");
      system = fallback?.useData || fallback?.data || undefined;
    }
    const assets: any[] = [], storyboard: any[] = [];
    for (const ref of info) {
      if (ref.sources === "storyboard") {
        const shot = await u.db("o_storyboard").where({ ...scope, id: ref.id }).whereNull("retiredAt")
          .first("videoDesc", "prompt", "track", "duration", "shouldGenerateImage");
        if (!shot) throw new Error("分镜参考已失效");
        storyboard.push(shot);
      } else {
        const asset = await u.db("o_assets").where({ projectId: scope.projectId, id: ref.id })
          .leftJoin("o_image", "o_image.id", "o_assets.imageId")
          .first("o_assets.id", "o_assets.type", "o_assets.name", "o_image.filePath");
        if (!asset) throw new Error("素材参考已失效");
        assets.push(asset);
      }
    }
    const content = `**模型名称**：${modelId},\n**资产信息**：${assets.filter(a => a.filePath)
      .map(a => `[${a.id},${a.type},${a.name}]`).join("，")},\n**分镜信息**：${storyboard
      .map(s => `<storyboardItem videoDesc='${s.videoDesc}' duration='${s.duration}'></storyboardItem>`).join("，")}`;
    const { text } = await u.Ai.Text("universalAi").invoke({ system,
      messages: [{ role: "assistant", content: u.getArtPrompt(project?.artStyle || "无", "art_skills", "art_storyboard_video") },
        { role: "user", content }] });
    const result = await settleRevisionWork(scope, guard, "SUCCEEDED", { prompt: text });
    return result === "SETTLED" ? text : null;
  } catch (error: any) {
    try { await settleRevisionWork(scope, guard, "FAILED", { error: u.error(error).message }); }
    catch (settleError) { console.error("[RevisionWorkGuard] prompt settlement failed", settleError); }
    return null;
  }
}

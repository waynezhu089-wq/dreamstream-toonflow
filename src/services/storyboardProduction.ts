import { z } from "zod";
import u from "@/utils";
import { resolveProductionProfile } from "@/agents/productionAgent/profile";
import { advertisementProductionContext } from "@/services/advertisementProductionContext";
import { assertAssetPlanBinding } from "@/services/advertisementAssetPlan";
import { productionId, ProductionGateError } from "@/services/advertisementGate";
import { requireModel } from "@/services/modelPreset";

export const productionFields = {
  productionMode: z.enum(["REAL_ASSET_DIRECT", "AI_TEXT_TO_IMAGE", "AI_REFERENCE_GENERATE", "REAL_AI_COMPOSITE"]).nullable().optional(),
  primaryAssetId: z.number().int().positive().nullable().optional(),
  referenceAssetIds: z.array(z.number().int().positive()).max(200).optional(),
  referenceAssetGroupIds: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
  promptSkillId: z.string().trim().min(1).max(256).nullable().optional(),
  promptSkillVersion: z.string().trim().min(1).max(128).nullable().optional(),
  capabilityId: z.string().trim().min(1).max(256).nullable().optional(),
};
const specSchema = z.object(productionFields);
const emptySpec = { productionMode: null, primaryAssetId: null, referenceAssetIds: [] as number[], referenceAssetGroupIds: [] as string[], promptSkillId: null, promptSkillVersion: null, capabilityId: null };
export function productionSpec(row: { productionSpec?: string | null }) {
  if (!row.productionSpec) return { ...emptySpec };
  // Corrupt persisted semantics must never silently become text-to-image.
  return { ...emptySpec, ...specSchema.parse(JSON.parse(row.productionSpec)) };
}
export function semanticProductionSpec(spec: ReturnType<typeof productionSpec>) {
  return { productionMode: spec.productionMode, primaryAssetId: spec.primaryAssetId,
    referenceAssetIds: [...spec.referenceAssetIds].sort((a, b) => a - b),
    referenceAssetGroupIds: [...spec.referenceAssetGroupIds].sort() };
}
export function executionProductionSpec(spec: ReturnType<typeof productionSpec>) {
  return { promptSkillId: spec.promptSkillId, promptSkillVersion: spec.promptSkillVersion, capabilityId: spec.capabilityId };
}
export function effectiveImagePrompt(row: { imagePrompt?: string | null; prompt?: string | null }) {
  return row.imagePrompt?.trim() || row.prompt || "";
}
export class StoryboardProductionError extends ProductionGateError {}
const fail = (message: string, code: string) => { throw new StoryboardProductionError(message, code, 409); };

export async function isAdvertisement(projectId: number) {
  const project = await u.db("o_project").where({ id: productionId(projectId) }).first();
  if (!project) throw new ProductionGateError("项目不存在", "PRODUCTION_CONTEXT_INVALID", 404);
  return resolveProductionProfile(project).key === "advertisement";
}

async function validateReferences(projectId: number, scriptId: number, spec: ReturnType<typeof productionSpec>, associateAssetsIds: number[] = []) {
  const context = await advertisementProductionContext(projectId, scriptId);
  if (!context) throw new ProductionGateError("当前项目不是广告");
  const allowed = new Set(context.assets.map(a => a.assetId));
  const selected = [...spec.referenceAssetIds, ...associateAssetsIds, ...(spec.primaryAssetId === null ? [] : [spec.primaryAssetId])];
  if (selected.some(id => !allowed.has(id))) fail("素材必须是当前项目和制作单元 Asset Plan 的有效绑定", "STORYBOARD_ASSET_SCOPE_INVALID");
  if (spec.primaryAssetId !== null) {
    await u.db.transaction(trx => assertAssetPlanBinding(trx, { projectId, scriptId }, { assetId: spec.primaryAssetId, sourcePolicy: "REAL_REQUIRED" }));
  }
}

// Batch-shaped service: single add/edit and whole replacement share one contract.
// Omitted edit fields retain their previous values; replacement requires explicit mode.
export async function writeAdvertisementStoryboards(projectId: number, scriptId: number, items: any[], operation: "add" | "replace" | "edit") {
  projectId = productionId(projectId); scriptId = productionId(scriptId);
  if (!items.length || items.length > 200) throw new ProductionGateError("分镜列表不能为空且最多 200 项");
  const prepared: { item: any; previous: any; spec: ReturnType<typeof productionSpec> }[] = [];
  for (const item of items) {
    const previous = operation === "edit" ? await u.db("o_storyboard").where({ id: productionId(item.id), projectId, scriptId }).first() : undefined;
    if (operation === "edit" && !previous) throw new ProductionGateError("分镜不属于当前项目和制作单元");
    const spec = { ...(previous ? productionSpec(previous) : emptySpec), ...specSchema.parse(item) };
    if (!spec.productionMode && operation !== "edit") fail("请明确选择镜头生产方式，不能从旧开关或关联列表猜测", "PRODUCTION_MODE_REQUIRED");
    if (spec.productionMode === "REAL_ASSET_DIRECT" && spec.primaryAssetId === null) fail("真实素材直用必须指定主素材", "PRIMARY_ASSET_REQUIRED");
    await validateReferences(projectId, scriptId, spec, item.associateAssetsIds ?? []);
    prepared.push({ item, previous, spec });
  }
  return u.db.transaction(async trx => {
    if (operation === "replace") {
      if (await trx("o_video").where({ projectId, scriptId }).first()) fail("当前制作单元已有视频记录，禁止整套替换分镜", "STORYBOARD_REPLACE_HAS_VIDEO");
      const old = await trx("o_storyboard").where({ projectId, scriptId });
      await trx("o_assets2Storyboard").whereIn("storyboardId", old.map(r => r.id)).delete();
      await trx("o_imageFlow").whereIn("id", old.map(r => r.flowId).filter(Boolean)).delete();
      await trx("o_storyboard").where({ projectId, scriptId }).delete();
      await trx("o_videoTrack").where({ projectId, scriptId }).delete();
    }
    const result = [];
    const tracks = new Map<string, number>();
    const last = operation === "add" ? await trx("o_storyboard").where({ projectId, scriptId }).max("index as lastIndex").first() : null;
    const firstIndex = last?.lastIndex == null ? 0 : Number(last.lastIndex) + 1;
    for (const [index, { item, previous, spec }] of prepared.entries()) {
      const encoded = JSON.stringify({ schemaVersion: 1, ...spec });
      const changed = previous && (JSON.stringify(productionSpec(previous)) !== JSON.stringify(spec) || item.prompt !== previous.prompt);
      let id = previous?.id;
      if (previous) {
        await trx("o_storyboard").where({ id, projectId, scriptId }).update({
          prompt: item.prompt, videoDesc: item.videoDesc, productionSpec: encoded,
          ...(changed ? { state: "未生成", filePath: "", reason: "" } : {}),
        });
      } else {
        const track = item.track || "未分组";
        let trackId = tracks.get(track);
        if (trackId === undefined) {
          const existing = await trx("o_storyboard").where({ projectId, scriptId, track }).whereNotNull("trackId").first();
          trackId = existing?.trackId ?? (await trx("o_videoTrack").insert({ projectId, scriptId, duration: 0 }))[0];
          tracks.set(track, trackId!);
        }
        [id] = await trx("o_storyboard").insert({ projectId, scriptId, trackId, track, index: firstIndex + index,
          prompt: item.prompt ?? "", videoDesc: item.videoDesc, duration: String(item.duration),
          state: "未生成", filePath: "", reason: "", productionSpec: encoded,
          shouldGenerateImage: spec.productionMode === "REAL_ASSET_DIRECT" ? 0 : 1, createTime: Date.now() + index });
        const shots = await trx("o_storyboard").where({ projectId, scriptId, trackId });
        await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).update({ duration: shots.reduce((sum, shot) => sum + Number(shot.duration), 0) });
      }
      if (item.associateAssetsIds !== undefined || !previous) {
        await trx("o_assets2Storyboard").where({ storyboardId: id }).delete();
        const ids = [...new Set(item.associateAssetsIds ?? [])] as number[];
        if (ids.length) await trx("o_assets2Storyboard").insert(ids.map(assetId => ({ assetId, storyboardId: id })));
      }
      const row = await trx("o_storyboard").where({ id, projectId, scriptId }).first();
      result.push({ ...row, ...spec, duration: Number(row.duration), src: row.filePath ? await u.oss.getSmallImageUrl(row.filePath) : null,
        associateAssetsIds: await trx("o_assets2Storyboard").where({ storyboardId: id }).orderBy("rowid").pluck("assetId") });
    }
    return result;
  });
}

// Per-item dispatch preserves partial success and single/multi-item retries.
export async function produceAdvertisementStoryboard(projectId: number, scriptId: number, id: number, requestModel?: string) {
  const where = { id, projectId, scriptId };
  const row = await u.db("o_storyboard").where(where).first();
  if (!row) throw new ProductionGateError("分镜不属于当前项目和制作单元");
  try {
    const spec = productionSpec(row);
    await validateReferences(projectId, scriptId, spec);
    switch (spec.productionMode) {
      case "REAL_ASSET_DIRECT": {
        if (spec.primaryAssetId === null) fail("真实素材直用必须指定主素材", "PRIMARY_ASSET_REQUIRED");
        if (spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) fail("真实素材直用不消费参考输入，请明确主素材", "CAPABILITY_INPUT_UNSUPPORTED");
        if (spec.capabilityId && spec.capabilityId !== "toonflow.real-asset-direct.v1") fail("当前未实现所选直出能力", "CAPABILITY_NOT_IMPLEMENTED");
        // Revalidate current upload receipt/image in the same transaction as output.
        await u.db.transaction(async trx => {
          await assertAssetPlanBinding(trx, { projectId, scriptId }, { assetId: spec.primaryAssetId, sourcePolicy: "REAL_REQUIRED" });
          const asset = await trx("o_assets").where({ id: spec.primaryAssetId, projectId }).first();
          const image = await trx("o_image").where({ id: asset.imageId, assetsId: asset.id }).first();
          await trx("o_storyboard").where(where).update({ filePath: image.filePath, state: "已完成", reason: "" });
        });
        break;
      }
      case "AI_TEXT_TO_IMAGE": {
        if (spec.primaryAssetId !== null || spec.referenceAssetIds.length || spec.referenceAssetGroupIds.length) fail("纯文生图不接受真实主素材或参考输入，请选择匹配的生产方式", "CAPABILITY_INPUT_UNSUPPORTED");
        if (spec.capabilityId && spec.capabilityId !== "toonflow.image.v1") fail("当前未实现所选 Capability", "CAPABILITY_NOT_IMPLEMENTED");
        const model = await requireModel(projectId, "image", requestModel);
        if (requestModel && requestModel !== model) fail("所选模型与当前项目配置不同，请保存配置后重试", "MODEL_CONFIG_MISMATCH");
        const project = await u.db("o_project").where({ id: projectId }).first();
        await u.db("o_storyboard").where(where).update({ state: "生成中", reason: "", filePath: "" });
        const input = { prompt: effectiveImagePrompt(row), size: project?.imageQuality as "1K" | "2K" | "4K", aspectRatio: project?.videoRatio as `${number}:${number}`, referenceList: [] };
        const image = await u.Ai.Image(model as `${string}:${string}`).run(input, { taskClass: "生成分镜图片", describe: "分镜图片生成", relatedObjects: JSON.stringify({ storyboardId: id, scriptId, ...spec, ...input }), projectId });
        const filePath = `/${projectId}/assets/${scriptId}/${u.uuid()}.jpg`;
        await image.save(filePath);
        await u.db("o_storyboard").where(where).update({ filePath, state: "已完成", reason: "" });
        break;
      }
      case "AI_REFERENCE_GENERATE":
        fail("CAPABILITY_INPUT_UNSUPPORTED：当前未实现参考图/组生成；真实 UI、Logo、标签不得由 AI 重画冒充原素材", "CAPABILITY_INPUT_UNSUPPORTED");
        break;
      case "REAL_AI_COMPOSITE":
        fail("请使用“背景 + 真实素材合成”单镜入口：先生成背景，再人工确认四角；普通批量生成不接受合成输入", "CAPABILITY_INPUT_UNSUPPORTED");
        break;
      default:
        fail("请先为该镜头指定 productionMode，不能从 shouldGenerateImage 推测", "PRODUCTION_MODE_REQUIRED");
    }
  } catch (e: any) {
    const code = e.code ?? "STORYBOARD_PRODUCTION_FAILED";
    await u.db("o_storyboard").where(where).update({ state: "生成失败", filePath: "", reason: `${code}: ${u.error(e).message}` });
  }
  const output = await u.db("o_storyboard").where(where).first();
  return { id, ...productionSpec(row), state: output!.state, reason: output!.reason, src: output!.filePath ? await u.oss.getSmallImageUrl(output!.filePath) : null };
}

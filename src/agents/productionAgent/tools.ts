import { productionFields } from "@/services/storyboardProduction";
import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";

import { advertisementProductionContext, assertAdvertisementAssetReferences } from "@/services/advertisementProductionContext";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  ...productionFields,
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  advertisement?: boolean;
  storyboardGeneration?: boolean;
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

/**
 * 串行队列：确保 socket 操作排队执行，避免并发过高导致假死
 * @param delayMs 每个操作之间的最小间隔(ms)
 */
function createSocketQueue(delayMs = 800) {
  let lastPromise: Promise<any> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    lastPromise = lastPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => fn().then(resolve, reject), delayMs);
        }),
    );
    return lastPromise;
  };
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const socketQueue = createSocketQueue(800);
  const workMap: Record<any, any> = {};
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取工作区数据",
      inputSchema: jsonSchema<{ key: keyof FlowData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        if (key === "assets") {
          const context = await advertisementProductionContext(resTool.data.projectId, resTool.data.scriptId);
          if (context) return context.assets;
        }
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);

        const flowData: FlowData = await new Promise((resolve) => socket.emit("getFlowData", { key }, (res: any) => resolve(res)));
        thinking.appendText(`获取到${flowDataKeyLabels[key]}:\n` + JSON.stringify(flowData[key], null, 2));
        thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成`);
        thinking.complete();
        if (workMap[key] && JSON.stringify(workMap[key]) === JSON.stringify(flowData[key])) {
          console.info(`[tools] get_flowData: ${flowDataKeyLabels[key]}数据未变化，无需更新`);
          return `${flowDataKeyLabels[key]}数据未变化，无需更新`;
        }
        workMap[key] = flowData[key];
        return flowData[key];
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().nullable().describe("衍生资产ID,如果新增则为空"),
            name: z.string().describe("衍生资产名称"),
            desc: z.string().describe("衍生资产描述"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        // 容错：LLM 偶尔传 "null" 字符串或空串，统一规范为 null
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const deriveAsset = { ...raw, id: normalizedId };

        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u.db("o_assets").where("id", deriveAsset.assetsId).select("id", "type").first();
        if (!parentAssets) return "关联的资产不存在";

        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        const res = await new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        const res = await new Promise((resolve) => socket.emit("delDeriveAsset", { assetsId, id }, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        new Promise((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成衍生资产，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("衍生资产开始完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("衍生资产生成失败:\n" + u.error(e).message);
            thinking.updateTitle("衍生资产生成失败");
            thinking.complete();
          });

        return "开始生成衍生资产";
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成分镜...");
        socketQueue(
          () =>
            new Promise((resolve, reject) =>
              socket.emit("generateStoryboard", { ids }, (res: any) => {
                if (res?.error) return reject(new Error(res.error));
                resolve(res);
              }),
            ),
        )
          .then((res) => {
            thinking.appendText("生成的分镜数据:\n" + JSON.stringify(res, null, 2));
            thinking.updateTitle(toolCpnfig.advertisement ? "分镜生产请求已接收，请检查最终状态" : "分镜生成完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("分镜生成失败:\n" + u.error(e).message);
            thinking.updateTitle("分镜生成失败");
            thinking.complete();
          });

        return "开始生成分镜";
      },
    }),
    add_flowData_storyboard: tool({
      description: "新增分镜面板到工作区",
      inputSchema: jsonSchema<{
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[] | null;
        shouldGenerateImage: string;
        productionMode?: "REAL_ASSET_DIRECT" | "AI_TEXT_TO_IMAGE" | "AI_REFERENCE_GENERATE" | "REAL_AI_COMPOSITE" | null;
        primaryAssetId?: number | null;
        referenceAssetIds?: number[];
        referenceAssetGroupIds?: string[];
        promptSkillId?: string | null;
        promptSkillVersion?: string | null;
        capabilityId?: string | null;
      }>(
        z
          .object({
            ...productionFields,
            videoDesc: z.string().describe("画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID"),
            prompt: z.string().nullable().describe("分镜图片提示词"),
            track: z.string().describe("分组"),
            duration: z.number().describe("视频推荐时间"),
            associateAssetsIds: z.array(z.number()).nullable().describe("该分镜所需的资产ID列表"),
            shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        await assertAdvertisementAssetReferences(resTool.data.projectId, resTool.data.scriptId, raw.associateAssetsIds ?? []);
        const thinking = msg.thinking("正在新增 分镜面板 数据...");
        const data = {
          ...Object.fromEntries(Object.keys(productionFields).filter(key => key in raw).map(key => [key, (raw as any)[key]])),
          videoDesc: raw.videoDesc,
          prompt: raw.prompt,
          track: raw.track,
          duration: raw.duration,
          associateAssetsIds: raw.associateAssetsIds ?? [],
          shouldGenerateImage: raw.shouldGenerateImage,
        };
        socketQueue(
          () =>
            new Promise((resolve, reject) =>
              socket.emit("addStoryboard", { ...data }, (res: any) => {
                if (res?.error) return reject(new Error(res.error));
                resolve(res);
              }),
            ),
        )
          .then((res) => {
            thinking.appendText("新增的分镜数据:\n" + JSON.stringify(data, null, 2));
            thinking.updateTitle("新增分镜成功");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("新增的分镜数据:\n" + JSON.stringify(data, null, 2));
            thinking.updateTitle("新增分镜失败");
            thinking.complete();
          });
        return true;
      },
    }),
    replace_flowData_storyboard: tool({
      description:
        "整套替换当前制作单元的分镜面板。仅在用户明确要求修订/清理已有分镜，并且需要让分镜面板与已确认的分镜表一一对应时使用。该工具是幂等修订入口，不用于普通新增。",
      inputSchema: jsonSchema<{
        items: Array<{
          videoDesc: string;
          prompt: string | null;
          track: string;
          duration: number;
          associateAssetsIds: number[] | null;
          shouldGenerateImage: "true" | "false";
        }>;
      }>(
        z
          .object({
            items: z
              .array(
                z.object({
                  ...productionFields,
                  videoDesc: z.string().describe("画面描述、场景、动作、台词、音效等"),
                  prompt: z.string().nullable().describe("分镜图片提示词"),
                  track: z.string().describe("分组"),
                  duration: z.number().positive().describe("视频推荐时间"),
                  associateAssetsIds: z.array(z.number()).nullable().describe("真实存在的关联资产ID；无资产时传空数组"),
                  shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
                }),
              )
              .min(1)
              .max(50)
              .describe("最终完整分镜列表，顺序即最终镜头顺序"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ items }) => {
        await assertAdvertisementAssetReferences(resTool.data.projectId, resTool.data.scriptId, items.flatMap(item => item.associateAssetsIds ?? []));
        const thinking = msg.thinking("正在整套替换分镜面板...");
        try {
          const res = await socketQueue(
            () =>
              new Promise<any>((resolve, reject) =>
                socket.emit("replaceStoryboard", { items }, (result: any) => {
                  if (!result?.success) return reject(new Error(result?.error || result?.message || "整套替换分镜失败"));
                  resolve(result);
                }),
              ),
          );
          thinking.appendText(`已将当前分镜面板替换为 ${items.length} 条最终分镜。\n`);
          thinking.updateTitle("整套替换分镜完成");
          thinking.complete();
          return res?.message ?? `已替换为 ${items.length} 条分镜`;
        } catch (e) {
          thinking.appendText("整套替换分镜失败:\n" + u.error(e).message);
          thinking.updateTitle("整套替换分镜失败");
          thinking.complete();
          throw e;
        }
      },
    }),
  };

  if (toolCpnfig.advertisement) {
    // Text planning and review cannot directly dispatch storyboard images.
    if (!toolCpnfig.storyboardGeneration) delete tools.generate_storyboard;
    // Auxiliary asset creation belongs to Asset Preparation, not Production planning.
    for (const name of ["add_deriveAsset", "del_deriveAsset", "generate_deriveAsset"]) delete tools[name];
    tools.get_advertisementAssetPlan = tool({
      description: "读取当前项目/制作单元已确认 Asset Plan 的有效生产资产语义（含真实 assetId）",
      inputSchema: jsonSchema(z.object({}).toJSONSchema()),
      execute: async () => advertisementProductionContext(resTool.data.projectId, resTool.data.scriptId),
    });
  }
  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};

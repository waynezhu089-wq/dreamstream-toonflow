import { createHash } from "node:crypto";
import { directorCanonical } from "./directorCompiler";
import { PilotError } from "./service";
import { dreamDirectorSeed } from "./directorProjectSeed";

export type DirectorSelection = { type: "PROJECT" | "ASSET" | "SHOT"; key: string } | null;
export function resolveDirectorContext(state: any, instruction: string, selectedObject: DirectorSelection = null) {
  const assets = state.assets.filter((a: any) => a.status === "ACTIVE");
  if (selectedObject?.type === "ASSET" && !assets.some((a: any) => a.canonicalKey === selectedObject.key))
    throw new PilotError("DIRECTOR_CONTEXT_INVALID", "选中的素材不属于当前项目或已失效", 422);
  if (selectedObject?.type === "SHOT" && !state.storyboards.some((s: any) => String(s.id) === selectedObject.key))
    throw new PilotError("DIRECTOR_CONTEXT_INVALID", "选中的镜头不属于当前制作单元", 422);
  if (selectedObject?.type === "PROJECT" && selectedObject.key !== String(state.project.id))
    throw new PilotError("DIRECTOR_CONTEXT_INVALID", "选中的项目与当前项目不一致", 422);
  const global = /整个片子|整部|全片|全局|所有|整体视觉|整体.*电影/.test(instruction);
  // Exact key token first, then exact name text. Never use a fuzzy name match.
  const explicitKeys: string[] = Array.from(instruction.match(/\b[A-Z][A-Z0-9_]*-\d+\b/g) ?? []);
  if (explicitKeys.some(key => !assets.some((a: any) => a.canonicalKey === key)))
    throw new PilotError("DIRECTOR_CONTEXT_INVALID", "消息中的素材标识不属于当前项目", 422);
  const keys = assets.filter((a: any) => explicitKeys.includes(a.canonicalKey));
  const names = assets.filter((a: any) => a.name && instruction.includes(a.name));
  const mentioned = keys.length ? keys : names;
  if (!global && mentioned.length > 1)
    throw new PilotError("DIRECTOR_TARGET_AMBIGUOUS", "请明确本次修改一个素材，或明确要求全片调整", 422);
  const target = !global ? mentioned[0]?.canonicalKey ?? (selectedObject?.type === "ASSET" ? selectedObject.key : null) : null;
  return { selectedObject, resolvedRevisionScope: target ? "SINGLE_ASSET" : "PROJECT",
    resolvedCanonicalKey: target, targetOrigin: target ? (keys.length ? "EXPLICIT_KEY" : names.length ? "EXPLICIT_NAME" : "SELECTED_OBJECT") : "PROJECT_INSTRUCTION" };
}

export function resolveProjectDirectorSeed(state: any, records = [dreamDirectorSeed]) {
  const record = records.find(r => r.projectId === state.project.id);
  if (!record) return null;
  const active = new Set(state.assets.filter((a: any) => a.status === "ACTIVE").map((a: any) => a.canonicalKey));
  if (record.canonicalKeys.some(key => !active.has(key))) return null;
  return { ...record, sourceHash: createHash("sha256").update(directorCanonical(record)).digest("hex"),
    authority: "PROJECT_DIRECTION_DEFAULT_ONLY", affectsGeneration: false };
}

export function directorFastPath(message: string, selected: DirectorSelection, assets: any[] = []) {
  // Appearance edits are deliberately left to the existing image-edit semantic route.
  if (/雀斑|衣服.*(改|换)|背景.*(亮|暗)|换.*发型|改.*颜色|加.*饰品/.test(message)) return false;
  if (/导演(方向|方案|视觉)|整部.*视觉|全片.*视觉|整个片子|整体视觉|不要.*赛博|不要.*游戏.*电影/.test(message)) return true;
  const named = assets.filter(a => a.status === "ACTIVE" && (message.includes(a.canonicalKey) || (a.name && message.includes(a.name))));
  return (selected?.type === "ASSET" || named.length === 1) && /可爱|庄严|压迫感|怪兽|敬畏|神圣|普通|升华|不要任何人物|梦里变|孤独|冒险感|救赎|气质|叙事角色|视觉定位/.test(message);
}

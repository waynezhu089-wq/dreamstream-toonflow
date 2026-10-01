import type { Knex } from "knex";
import u from "@/utils";
import { ProductionGateError } from "@/services/advertisementGate";

function reject(code: string, message: string): never { throw new ProductionGateError(message, code, 409); }

export function normalizeAttachPath(value: string, projectId: number): string {
  const path = u.replaceUrl(value).replace(/^\/+/, "");
  if (!path || path.includes("\\") || path.includes(":") || path.includes("\0") ||
    path.split("/").includes("..") || !path.startsWith(`${projectId}/`) || path === `${projectId}/`) {
    reject("ATTACH_CANDIDATE_SCOPE_INVALID", "图片路径不属于当前项目或不安全");
  }
  return path;
}

export async function readAttachCandidate(q: Knex.Transaction, projectId: number, flowId: number, candidatePath: string) {
  const flow = await q("o_imageFlow").where({ id: flowId }).first();
  if (!flow?.flowData) reject("ATTACH_FLOW_NOT_FOUND", "图片编辑记录不存在");
  let nodes: any[];
  try {
    const parsed = JSON.parse(flow.flowData);
    nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  } catch { reject("ATTACH_CANDIDATE_NOT_IN_FLOW", "图片编辑记录无效"); }
  const matches = nodes.flatMap(node => {
    const image = node?.type === "upload" ? node?.data?.image : node?.type === "generated" ? node?.data?.generatedImage : null;
    if (typeof image !== "string" || !image) return [];
    try {
      return normalizeAttachPath(image, projectId) === candidatePath ? [{ candidateNodeType: node.type as string, candidateNodeId: String(node.id ?? "") }] : [];
    } catch { return []; }
  }).sort((a, b) => a.candidateNodeId.localeCompare(b.candidateNodeId) || a.candidateNodeType.localeCompare(b.candidateNodeType));
  if (!matches.length) reject("ATTACH_CANDIDATE_NOT_IN_FLOW", "所选图片不是当前图片编辑记录中可保存的主图");
  return { flowId, candidatePath, ...matches[0] };
}

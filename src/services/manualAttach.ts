import { createHash } from "node:crypto";
import sharp from "sharp";
import u from "@/utils";
import { ProductionGateError } from "@/services/advertisementGate";
import { normalizeAttachPath, readAttachCandidate } from "@/services/attachCandidate";
import { beginCurrentImageAttempt, failCurrentImageAttempt, finishCurrentImageAttempt } from "@/services/productionAttempt";

type Scope = { projectId: number; scriptId: number; storyboardId: number };
const supported = new Set(["jpeg", "png", "webp", "gif", "tiff", "bmp", "avif"]);

export async function beginManualAttachAttempt(scope: Scope, flowId: number, url: string) {
  const candidatePath = normalizeAttachPath(url, scope.projectId);
  return beginCurrentImageAttempt(scope, "storyboard.image.attach", async q => {
    const proof = await readAttachCandidate(q, scope.projectId, flowId, candidatePath);
    return { producerType: "MANUAL_ATTACH", producerRef: `imageFlow:${flowId}`, producerInput: proof };
  });
}

export async function finishManualAttachAttempt(attemptId: string) {
  const attempt = await u.db("o_productionAttempt").where({ attemptId, producerType: "MANUAL_ATTACH", operationKey: "storyboard.image.attach" }).first();
  if (!attempt) throw new ProductionGateError("手动附图任务不存在", "PRODUCTION_ATTEMPT_NOT_FOUND", 404);
  if (attempt.status !== "RUNNING") return { attemptId, status: attempt.status, staleCode: attempt.staleCode ?? null };
  const input = JSON.parse(attempt.producerInput);
  let bytes: Buffer;
  let format: string | undefined;
  try {
    bytes = await u.oss.getFile(input.candidatePath);
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw Error("图片文件大小无效");
    const metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
    format = metadata.format;
    if (!format || !supported.has(format) || !metadata.width || !metadata.height) throw Error("不是受支持的图片");
    await sharp(bytes, { limitInputPixels: 40000000 }).resize(1, 1).toBuffer();
  } catch {
    const error = new ProductionGateError("候选图片不存在或无法读取", "ATTACH_CANDIDATE_FILE_INVALID", 409);
    await failCurrentImageAttempt(attemptId, error);
    throw error;
  }
  return finishCurrentImageAttempt(attemptId, {
    filePath: input.candidatePath, mediaType: format === "jpeg" ? "image/jpeg" : `image/${format}`,
    outputHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length,
    flowId: input.flowId, candidateNodeType: input.candidateNodeType, candidateNodeId: input.candidateNodeId,
  });
}

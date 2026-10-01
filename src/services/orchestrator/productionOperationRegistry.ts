// Only the server maps a real production route to its semantic operation.
export const productionOperations = {
  "/storyboard/batchgenerateimage": "storyboard.image.generate",
  "/storyboard/composite/start": "storyboard.image.composite",
  "/storyboard/composite/finish": "storyboard.image.composite",
  "/storyboard/updatestoryboardurl": "storyboard.image.attach",
  "/workbench/generatevideoprompt": "video.prompt.generate",
  "/workbench/batchgenerateprompt": "video.prompt.generate",
  "/workbench/updatevideoprompt": "video.source.update",
  "/workbench/updatevideoduration": "video.source.update",
  "/workbench/generatevideo": "video.generate",
  "/workbench/batchgeneratevideo": "video.generate",
  "/workbench/selectvideo": "video.accept",
  "/workbench/delvideo": "video.candidate.retire",
} as const;

export type ProductionOperationKey = typeof productionOperations[keyof typeof productionOperations];
export function operationForProductionRoute(route: string): ProductionOperationKey | null {
  return productionOperations[route.toLowerCase().replace(/\/+$/, "") as keyof typeof productionOperations] ?? null;
}
export function isVideoProductionOperation(operationKey: ProductionOperationKey) {
  return operationKey.startsWith("video.");
}

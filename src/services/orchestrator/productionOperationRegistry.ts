// Only the server maps a real production route to its semantic operation.
export const productionOperations = {
  "/storyboard/batchgenerateimage": "storyboard.image.generate",
  "/storyboard/composite/start": "storyboard.image.composite",
  "/storyboard/composite/finish": "storyboard.image.composite",
  "/storyboard/updatestoryboardurl": "storyboard.image.attach",
} as const;

export type ProductionOperationKey = typeof productionOperations[keyof typeof productionOperations];
export function operationForProductionRoute(route: string): ProductionOperationKey | null {
  return productionOperations[route.toLowerCase().replace(/\/+$/, "") as keyof typeof productionOperations] ?? null;
}

// Explicit, disposable-data-only real text-model diagnostic. Never applies proposals.
import path from "node:path";

async function main() {
  const dataDir = path.resolve(process.env.TOONFLOW_DATA_DIR || "");
  if (process.env.DS_V04_REAL_MODEL_TEST !== "1" || !dataDir.includes("v04-extraction-"))
    throw new Error("Use an explicit disposable v04-extraction data directory");
  const projectId = Number(process.env.DS_V04_TEST_PROJECT_ID);
  const scriptId = Number(process.env.DS_V04_TEST_SCRIPT_ID);
  const attempts = Number(process.env.DS_V04_TEST_ATTEMPTS || "1");
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(scriptId) || !Number.isInteger(attempts) || attempts < 1 || attempts > 5)
    throw new Error("Explicit project, script, and 1-5 attempts required");

  // Match the application's import order: fixDB uses the assembled utils facade.
  await import("@/utils");
  const { db, dbReady } = await import("@/utils/db");
  const { previewSkill } = await import("@/v04/skills");
  await dbReady;
  const snapshot = async () => ({
    assets: await db("o_v04Asset").where({ projectId }).orderBy("canonicalKey"),
    coverage: await db("o_v04AssetCoverage").where({ projectId, scriptId }).orderBy("position"),
    creative: await db("o_v04Creative").where({ projectId, scriptId }).first(),
  });
  const before = JSON.stringify(await snapshot());
  const results: unknown[] = [];
  try {
    for (let i = 0; i < attempts; i++) {
      const start = Date.now();
      try {
        const result = await previewSkill({ projectId, scriptId, method: "ASSET_EXTRACTION" });
        const output = result.output;
        results.push({ attempt: i + 1, success: true, elapsedMs: Date.now() - start,
          candidates: output.candidates.length, coverage: output.coverage.length,
          repairAttempts: result.repairAttempts,
          names: output.candidates.map((item: { name: string; assetKind: string }) => `${item.name}:${item.assetKind}`),
          merges: output.mergeSuggestions.map((item: { existingCanonicalKey: string }) => item.existingCanonicalKey),
          visualSystems: output.candidates.filter((item: { assetKind: string }) => item.assetKind === "MATERIAL_FX").map((item: { name: string }) => item.name),
          linkedRelations: output.candidates.flatMap((item: { name: string; relatedCandidateIndexes: number[]; sharedVisualSystemCandidateIndex: number | null }) => [
            ...item.relatedCandidateIndexes.map(index => `${item.name}->${output.candidates[index]?.name}`),
            ...(item.sharedVisualSystemCandidateIndex === null ? [] : [`${item.name}~>${output.candidates[item.sharedVisualSystemCandidateIndex]?.name}`]),
          ]),
          coverageTypes: Object.fromEntries([...new Set(output.coverage.map((item: { classification: string }) => item.classification))].map(classification => [classification, output.coverage.filter((item: { classification: string }) => item.classification === classification).length])),
          coverageLabels: output.coverage.map((item: { label: string }) => item.label),
          unlinkedCoverage: output.coverage.filter((item: { candidateIndexes: number[]; existingCanonicalKeys: string[] }) => !item.candidateIndexes.length && !item.existingCanonicalKeys.length).length,
          applied: result.applied });
      } catch (error) {
        results.push({ attempt: i + 1, success: false, elapsedMs: Date.now() - start,
          code: typeof error === "object" && error && "code" in error ? String(error.code) : "UNCLASSIFIED" });
      }
    }
    console.log("[V04 Extraction Real Diagnostic]", JSON.stringify({ results,
      zeroWrite: JSON.stringify(await snapshot()) === before }));
  } finally {
    await db.destroy();
  }
}

main().catch(error => { console.error("[V04 Extraction Diagnostic Setup]", error instanceof Error ? {
  name: error.name, location: error.stack?.split("\n").slice(1, 4).map(line => line.trim()),
} : "Error"); process.exitCode = 1; });

# OPT-033A verification / handoff

Status: EXPERIMENTAL / HUMAN PILOT PENDING.

## Automated evidence

Commands executed in isolated experimental checkouts using currently installed dependencies; fake providers/temporary SQLite for regression.

- Backend focused: node --test tests/v04-asset-pipeline.test.cjs tests/v04-asset-image-edit.test.cjs. 43 tests: 40 PASS, 3 existing optional real-provider tests SKIP, 0 FAIL. A final pipeline-only run covers the owner-liveness refinement. Covers exact immutable Director continuity, semantic drift rollback, Klein typed reference graph, scoped Director/source compilation, QA Attention, max-6 batches with partial failure, concurrent Generate All/reload deduplication, initial Brief/canonical ADD mapping, and abandoned preparation fencing. Existing worker fake Comfy test covers render -> new MAIN adoption -> old views STALE/files retained -> source-pinned Klein admission -> replay no duplicate.
- Backend full: node --test --test-concurrency=1 tests/*.test.cjs. 458 tests: 452 PASS, 6 SKIP, 0 FAIL. See backend-full-final.log. The subsequently added superseded-preparation barrier test and conservative initial-owner recovery refinement and exact Klein frozen-dimension/model metadata alignment were rerun in focused tests; this full count is not falsely presented as including that later test. Initial restricted run exposed four esbuild access-denied failures and legacy-route incompatibility; legacy routing preserved, then elevated temp-DB full regression passed. No false claim that the initial failed run passed.
- Backend tsc --noEmit: PASS, no diagnostics. npm lint is the same tsc command.
- Backend npm run build: PASS. Restricted first build encountered host/sandbox access failure; normal elevated build passed. Generated bundle not committed because local root-router/type overrides are intentionally uncommitted.
- Frontend focused node --test tests/v04-studio.test.cjs: 21/21 PASS. Existing mounted Studio interaction regression also ran. New tests cover persisted phase/Attention UI, scoped stale purpose exclusion and source creation/refresh no-admission boundary.
- Frontend full node --test tests/*.test.cjs: 239/239 PASS.
- Frontend npm run build-only: PASS. Existing symlinked dependency resolution required elevated build.
- Frontend type-check: BLOCKED by existing TS5103 Invalid value for --ignoreDeprecations, not passed. Initial standard command also hit TS5033 writing dependency .tmp through a symlink; recheck with workspace tsBuildInfoFile removed that obstacle and confirmed TS5103. No change to dependency/config to conceal it. Full frontend type correctness remains unverified behind that blocker.

## Files / implementation areas

Backend new: assetPipeline.ts, assetPipelinePrompt.ts, assetPipelineQuality.ts, assetViewPlan.ts, kleinAssetProfile.ts; focused v04-asset-pipeline.test.cjs.
Backend changed: assetImageBaseline.ts, assetImageEdit.ts, autoAsset.ts, directorBible.ts, localFastVision.ts, operations.ts, operationsRegistry.ts, v04/router.ts, service.ts, skills.ts, studioTurn.ts; v04-asset-image-edit.test.cjs.
Frontend new: assetPipelineView.ts.
Frontend changed: StudioWorkspace.vue, StudioAssetDrawer.vue, studioDraftImageView.ts; v04-studio.test.cjs.
Existing local backend src/router.ts and src/types/database.d.ts hashes were verified unchanged and excluded. Existing untracked frontend generated Vite files/logs retained and excluded. No schema, Stable, accepted 001E or control-repo modification.

## Safety and remaining validation

Real local generation evidence is in HUMAN_PILOT_REPORT.md. Do not equate SUCCEEDED with accepted/useful view. Whale rear/submarine rear remain Attention. Coarse local inspector is unavailable in this process; no external Vision is called. No downloads/installations or Stable/protected-DB access. One actual text Agent invocation and local Comfy candidate generation were within this work order; no cloud image/video route was added.

Human adoption/Director inheritance/real new-view regeneration awaits Wayne. The engineering fake-provider loop passed, but real Human Pilot is not declared PASS. New-project initial extraction itself has deterministic mocked regression, not a claim of real-model creative quality. Integration is a reviewed future dependency bundle, not a merge action.

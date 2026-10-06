# OPT-DIR-032A — Whale Director / Asset Design A/B Harness

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Engineering ready; visual hypothesis untested.

## Baselines and scope

Backend before: `d0560e3bf4295ef79a02231f624d66f28fa991f2`.
Frontend before: `8ce8ce067cbcedcc07af9f5507bd8f8770684a14`.
Frontend delivery: `6c815b4324e8deeec9b8e113899c2e9404f2ab47`.
Both branches: `dreamstream/v0.4-project-agent-pilot`.
Backend delivery is the commit containing this report; the final response records its exact SHA.

Stable refs verified unchanged:
- Backend `194340d6a37c6ef03a6d157f5848490f67c2e834`
- Frontend `986fb0ff32fd257498974c6c87cf4c47f360cb03`

Only CHAR-003 CREATURE / AI_ALLOWED is supported. No other asset renderer, shot integration, adoption or platform-wide Director generation change.

## Actual source before editing

Project `1790941805789310`, script `4`, CHAR-003 revision `1`.
Accepted Director v1 ID `b79a0985-0c92-406a-a0c7-bbd19313908e`, CURRENT; affectsGeneration remains false.
Confirmed Whale Visual Spec: none. Existing current-revision persisted draft is reused by the exact existing `preparedSpec` selection function; it is explicitly labelled PERSISTED_DRAFT, never CONFIRMED.
No accepted image baseline decision. Successful jobs remain:
- ASSET_MAIN_PREVIEW `da45b4df-aa9f-4d45-a2ca-2ce85e6fb942`
- HERO_3Q `e3f2fc01-bd48-4d98-839c-73d2f45ed57d`
- SIDE_PROFILE `81311adf-3a26-4d35-8ee2-b15ac8922138`
- BACK_3Q `e40f821f-0bf5-4382-acf4-d81bf50ebbf3`

Read-only live capture succeeded with source hash `26d0e7a8c725383cd1396a4dd58480c61a019b4342c766c06bf6991e18233c56`.
Actual route: KREA2_T2I_ASSET_V1. Director role carries immense/ancient/awe-first/ship-swallowing scale and anti-mascot/anti-horror constraints. Current accepted `scaleRelations` is empty: the compiler does not fabricate edges. Source facts take precedence over ticket examples.

## Compiler fidelity and projection

One SQLite snapshot captures exact accepted Director freshness, current asset, Creative, persisted/confirmed spec, baseline/reference metadata, current-revision job metadata, route and executor configuration. No model, image-byte read or Comfy request during compilation.

A reuses `compileStudioDraftPromptsInTransaction` for existing validation and `autoAssetPrompt(..., ASSET_MAIN_PREVIEW)` verbatim for the current execution prompt. Its exact draft Prompt IR, preview plan and generationIntent are also frozen as legacyCompilation evidence; Review Plan compiler changes therefore invalidate source freshness. Execution traces use that captured actual generationIntent. `preparedSpec` is exported without algorithm changes. A is not an old frozen historical prompt and is not deliberately weakened.

B shares the exact semantic input and A prompt prefix. A dedicated model-independent DirectorAssetContext selects only the asset's role, global Visual DNA, touching non-shot scale relations and touching transformation lineage. Its execution-layer augmentation protects isolated-subject composition and identity/materials. Scale references are not additional rendered subjects; film material motifs do not turn a living creature into Dream Matter. No Pegasus role or shot context is dumped into B.

The experiment freezes both exact graphs, hashes, source evidence, version IDs, timestamps and shared settings. Same existing Krea topology, UNet, CLIP, VAE, no LoRA, resolution 768×1024, 8 steps, CFG 1, euler/simple, denoise 1, tiled decode and identical seed. Only positive text differs. Seed is deterministic from captured source; SaveImage prefix is identical across A/B. Existing workflow code is untouched.

## Persistence and render authorization

New experimental-only `o_v04DirectorAssetAB` stores immutable compiled evidence plus independent execution and human evaluation state. It is separate from normal draft jobs/artifacts and not discovered by Asset World or Reference Pack selection. No business schema columns were changed.

Authenticated endpoints under `/api/v04/director/asset-ab/`:
- `compile`: projectId/scriptId; only compilation and experiment record.
- `current`: projectId/scriptId; latest 20 records, live freshness projection.
- `render`: projectId/scriptId/experimentId/pairHash/confirmRender=true.
- `artifact`: projectId/scriptId/experimentId/side; authenticated binary response, file hash checked.
- `evaluate`: projectId/scriptId/experimentId, exactly six A/B/Same choices, human conclusion and optional reason.

All paths check project owner and unit scope. Source drift blocks first render and projects STALE. Existing experiment/render requests replay state without a second submission. There is no startup enqueue or automatic retry.

Explicit render uses the existing cross-process draft-worker GPU lease plus an empty Comfy queue check. A then B are serialized. Exact submitted graphs use existing Operations trace capture. Outputs are exclusively EXPERIMENTAL_CANDIDATE under `v04-director-ab`; no MAIN_PREVIEW, baseline, asset/reference or authority writes.

A failure prevents B. B failure preserves A. OOM or output-size mismatch fails the pair; no unilateral resolution/quality fallback. Source drift between sides prevents B, retains A, marks STALE. Postflight drift retains both artifacts as STALE. Restart fences interrupted experiments/owned traces as EXECUTION_UNCERTAIN and never resubmits.

## Professional UI

Professional → Director contains the independent A/B panel. Normal Studio generation surface is unchanged.
Human semantic comparison first; raw evidence/prompts/exact graphs are collapsed. Compile does not render. Render opens a safety confirmation, blocks duplicate clicks and shows independent A/B execution states. Refresh/reload restores persisted state; late old-unit compile/image responses are discarded.

Completed artifacts appear side-by-side using authenticated blob retrieval and the existing image lightbox. Six explicit human dimensions include A-worse/B-worse interpretation for cute/monster questions. Conclusion is manually selected, never automatically scored. No Adopt control.

## Verification actually run

Backend:
- `node --test --test-name-pattern=DIR032A tests/v04-pilot.test.cjs`: 8/8 PASS.
- `node --test tests/*.test.cjs`: 399 total, 393 PASS, 6 SKIP, 0 FAIL.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.

Frontend:
- `node --test tests/v04-director-ab.test.cjs tests/v04-director-inspection.test.cjs tests/v04-director-bible.test.cjs`: 13/13 PASS, including 5 new A/B tests.
- `node --test tests/*.test.cjs`: 212/212 PASS.
- `npm run build-only -- --config vite.config.ts`: PASS.
- `npm run type-check`: BLOCKED / PRE-EXISTING TS5103 in tsconfig.app.json. Not reported as a pass.

Initial sandbox build/backend suite attempts failed due to dependency-path access/OS-user restrictions; rerun with required access to already-installed dependencies passed as above. No dependency update.

Tests use temporary SQLite and fake local Comfy. Real HTTP route tests check auth/scope, compile/read, missing render consent and hash mismatch. Other tests prove exact current A, relevant B, graph/seed equality, zero model/producer on compile, truth immutability, drift, sequential success, A/B failures, artifact roles, trace graph bytes, restart fencing, shared GPU lease, mounted semantic gate, refresh/lightbox/evaluation and late scope responses.

Experimental runtime reload: all 70 existing non-Director business tables have identical ordered logical-record hashes before/after. Existing Director version/proposal state and Whale jobs remain unchanged. New A/B table exists with zero rows; no real render or human evaluation was performed. Local Comfy `/object_info` confirms all nine graph nodes and exact UNet/CLIP/VAE model names are already available. No downloads/installations.

## Changed files

Backend:
- src/app.ts
- src/v04/autoAsset.ts (export-only seam)
- src/v04/directorBible.ts (read-only transaction seam)
- src/v04/router.ts
- src/v04/directorAssetAB.ts
- src/v04/directorAssetABCompiler.ts
- src/v04/directorAssetABSchema.ts
- tests/v04-pilot.test.cjs
- pilot/OPT_DIR_032A_IMPLEMENTATION_REPORT.md

Frontend:
- src/views/pilot/PilotShell.vue
- src/views/pilot/DirectorAssetABPanel.vue
- tests/v04-director-ab.test.cjs

Existing backend router/types local overrides and frontend generated config overrides remain untouched and uncommitted. Build-generated tracked backend bundle is restored, not committed.

## Boundaries and next Human Pilot

Engineering checks are not a rendered quality judgment. RENDERED: NO. No paid model, real Comfy prompt, downloads or protected DB access. No Asset Bible, confirmed Visual Spec, Prompt IR, baseline, Reference Pack, Director or 001E semantic change. Stable unchanged; no PR/merge/force push.

Runtime Studio: http://127.0.0.1:50189/#/studio
Professional: http://127.0.0.1:50189/#/professional
Backend: http://127.0.0.1:10589

1. Open Professional, select the existing project/unit 4, then Director.
2. Click compile Whale A/B input. Review A is the full current asset input and B adds accepted v1 only. Expand raw prompts/evidence if needed.
3. Verify magnitude, ancient/sublime/awe-first and anti-cute/anti-horror meaning, living-creature materials and no additional actual actors/ship.
4. Stop at this first human gate. Only after agreeing the semantics, explicitly use the render confirmation to produce A then B.
5. Compare identical settings and images; record six human choices and conclusion. Do not adopt either output. Stop after Whale; Pirate Ship/Pegasus need separate authorization.

Limitations: only current Krea T2I route is supported; another route fails closed. Model file bytes are not hashed (exact filenames/graph/settings captured). External users can manually submit Comfy jobs after the empty-queue check; the shared lease coordinates Dream Stream workers, not arbitrary external clients. Render workers are intentionally local and do not auto-resume after restart. Only latest 20 experiment records appear in UI. Browser visual Human Pilot and real A/B quality comparison remain pending. No platform-wide quality claim.

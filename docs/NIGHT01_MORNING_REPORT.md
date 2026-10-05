# Visual Intelligence Program / Night 01 — Morning Report

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Design documents and candidates are NOT_FROZEN and not Project Truth.

## Overnight status

| Phase | Status | Delivered / boundary |
|---|---|---|
| 1 Architecture audit | PASS | Actual source and persisted-input evidence; rendered causality explicitly unverified. |
| 2 Director contracts | PASS | Six model-independent candidate structures; strict pure validation. |
| 3 Hero / reference split | PASS | Compatible design, existing roles preserved; no generation change. |
| 4 Asset / shot modes | PASS | Semantic boundary design, not executor rollout. |
| 5 Visual QA | PASS | Evidence/verdict/action design only; no vision/model call. |
| 6 Dream-project dry-run | PASS | Real read-only source; 8 core roles, 8 candidate beats/shot intentions; compiled deterministically. |
| 7 A/B semantic comparison | PASS | Whale/ship/Pegasus actual frozen prompts vs augmented candidates; no rendered A/B. |
| 8 Implementation plan | PASS | Five scoped future tickets, dependencies/tests/stop rules; ID collision flagged. |
| 9 Safe Phase A | PASS | Pure contracts/compiler, authenticated read-only endpoint, Professional inspection, real HTTP + mounted regressions. No persistence/apply or generation integration. |
| 10 Engineering verification | PARTIAL | All tests and builds pass; backend typecheck passes; frontend standard typecheck BLOCKED by existing TS5103. |

## Most important discovery

The latest successful whale/ship/Pegasus frozen inputs have mostly empty scale/proportion/material details and repeat narrative descriptions alongside generic rendering language. Current code already includes isolated/no-human asset constraints; those historical jobs used an older composition line. This is a missing structured design/role/scale layer plus a historical-input distinction, not evidence that one more negative prompt guarantees a fix. No generated image was inspected or produced tonight.

## Implementation

Backend implementation + audit commit: `8b4ee81927e1c33a4cfd50fbe579eab4e0ea5bf2`.
Frontend commit: `02828f6a450bd0eec052a19c763a00660fce0c58`.
Branch: `dreamstream/v0.4-project-agent-pilot` in both repositories. This report is a later documentation-only backend commit; its SHA is reported in the handoff.

`POST /api/v04/director/dry-run` accepts `{projectId,scriptId,intent?}` and returns a candidate bound to captured source: `persisted=false`, `affectsGeneration=false`, sourceCreativeVersion/sourceHash/candidateHash, intent, assetIndex and unresolved warnings. Scope-only calls return unresolved director fields honestly; they do not invoke a model. Professional's Director tab makes an explicit click-triggered request, prevents duplicate requests and discards old-unit replies. It does not expose Confirm/Apply.

Tests prove success, rejection and a real malformed-persisted-JSON exception path leave all temporary SQLite logical records unchanged, with zero model calls. Real router authentication/project authorization is exercised; test harness supplies identity upstream and is not a full login/JWT end-to-end test. No test uses the retained business database.

## Files created

Backend `docs/`:

- VISUAL_INTELLIGENCE_ARCH_AUDIT_V1.md
- DIRECTOR_INTELLIGENCE_CONTRACT_V1.md
- ASSET_DESIGN_SYSTEM_V2.md
- ASSET_VS_SHOT_GENERATION_V1.md
- VISUAL_QA_V1.md
- DIRECTOR_INTENT_DRY_RUN.json
- DIRECTOR_INTENT_DRY_RUN_COMPILED.json
- DIRECTOR_INTENT_DRY_RUN_REVIEW.md
- DIRECTOR_AB_COMPARISON.md
- VISUAL_INTELLIGENCE_IMPLEMENTATION_PLAN_V1.md
- NIGHT01_SOURCE_EVIDENCE.json
- NIGHT01_FROZEN_INPUT_EVIDENCE.json
- NIGHT01_MORNING_REPORT.md

Backend code: src/v04/directorContract.ts, directorCompiler.ts, directorDryRun.ts.
Frontend: src/views/pilot/DirectorInspection.vue; tests/v04-director-inspection.test.cjs.

Files changed: backend src/v04/router.ts, tests/v04-pilot.test.cjs; frontend src/views/pilot/PilotShell.vue. Existing local backend router/types overrides and untracked frontend Vite files were preserved and excluded from commits.

## Commands / results

| Repository | Command | Actual result |
|---|---|---|
| Backend | `node --test --test-name-pattern=Night01 tests/v04-pilot.test.cjs` | 2/2 PASS |
| Backend | `node --test tests/*.test.cjs` | 382 total: 376 PASS, 6 intentional real-model/Comfy tests SKIPPED, 0 FAIL |
| Backend | `node_modules/.bin/tsc --noEmit` | PASS |
| Backend | `npm run build` | PASS |
| Frontend | `node --test tests/v04-director-inspection.test.cjs` | 2/2 PASS |
| Frontend | `node --test tests/*.test.cjs` | 200/200 PASS |
| Frontend | `npm run build-only -- --config vite.config.ts` | PASS |
| Frontend | `npm run type-check` | BLOCKED: tsconfig.app.json(5,27) TS5103 invalid --ignoreDeprecations; not fixed or hidden |

Initial restricted runs hit shared-dependency/esbuild path access errors (and backend build os.userInfo ENOMEM); authorized unrestricted verification subsequently passed. Frontend build retains existing PostCSS deprecation warning. This is not a clean frontend typecheck claim.
Local logs are in the workspace root: night01-backfocused.log, night01-backfull-final.log, night01-backtype.log, night01-backbuild-final.log, night01-frontfocused.log, night01-frontfull.log, night01-frontbuild-final.log, night01-fronttype-final.log.

## Stable / data / runtime

Stable remote branch SHAs were checked against the exact requested values:
Backend `194340d6a37c6ef03a6d157f5848490f67c2e834`;
Frontend `986fb0ff32fd257498974c6c87cf4c47f360cb03`.
UNCHANGED YES. No Stable branch, Stable userdata, protected historical database, models or Comfy workflows were accessed or modified. No paid API, image/video generation, download, migration, automatic acceptance, PR or merge.

Existing experimental Project Truth was recaptured read-only with the same fields/range and compared as complete logical content: `LOGICAL_TRUTH_MATCH True`. This covers captured Creative/assets/storyboards/confirmed specs/coverage/reference links, not every lifecycle table in the live application.

The existing experimental backend10589 PID47232 and frontend50189 PID49088 remained listening when checked. Neither was restarted by this batch. The new backend endpoint was verified with the real router against temporary SQLite, not rolled into the already-running server. A controlled experimental backend restart is needed before using the new live Professional inspection tab. No live browser visual QA claimed. Existing launcher remains intact; no application startup against the protected DB.

## Decisions required from Wayne

1. Pegasus→Logo: keep material transformation through Pegasus, then composition-only resolution to real Logo (recommended), or separately revise Creative. Current Treatment does not authorize an AI physical Logo morph.
2. Director acceptance/version ownership: project-level accepted Director proposal + unit projections recommended; persistence/Source integration needs a separate frozen contract. Not implemented tonight.
3. Qualify/renumber requested OPT-031/OPT-030 because prior tickets already use those IDs. This report does not supersede them.

## Known limits / next action

- Current project has zero active production storyboards. Eight dry-run intentions are not persisted shots, production bindings or a timing proof.
- Four supporting asset roles remain unresolved and are explicitly warned. Ancient/majestic whale direction is a work-order candidate, not confirmed Visual Spec.
- Compiler's source size cap is after readPilot capture; underlying historical reads are not newly bounded. A bounded current-state read is needed before large-project rollout.
- Offline compiled JSON uses the disclosed evidence projection, not a claimed byte-identical live readPilot capture/hash.
- No output quality, QA model, accepted Director Truth or generation improvement was verified.

Recommended next human action: review DIRECTOR_INTENT_DRY_RUN_REVIEW.md and DIRECTOR_AB_COMPARISON.md; decide whale perception, Logo resolution and Director acceptance scope. Only then separately authorize the next ticket. Do not start model generation from this batch.

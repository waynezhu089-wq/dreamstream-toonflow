# Visual Intelligence Architecture Audit V1 — Night 01
Status: EXPERIMENTAL / REVIEW_REPORT / NOT_FROZEN
Date: 2026-10-06
Source baselines: backend 0ff265a3f99b3c818f33ce7bdb31b8deae87eaad; frontend 9b3dd8063add58ec9a23953d4c1166743024e7f5. Method: actual source reads/searches, one read-only experimental SQLite snapshot, persisted job input snapshots. No media generation or visual QA.

## Existing responsibilities and insertion point
| Layer | Actual source / function | Already owns | Reuse / missing boundary |
|---|---|---|---|
| Truth / Creative | src/v04/service.ts:72 readPilot; applyCreative | Current Creative version, scope, human apply with previewHash | Reuse authoritative snapshot. No second editable Creative store. |
| Asset Bible | service.ts newAsset/previewAssets/applyAssets | canonicalKey, identity/preserve/forbidden traits, relationships, sourcePolicy | Add roles to existing identities; do not invent new Boy/Logo identities. |
| Agent context | src/v04/agentContext.ts:17 buildProjectAgentContext / renderProjectAgentSystem | project-stable memory, compact index, confirmed references, relevant detail | Retrieval is context, not Truth; do not splice independent reads into Director capture. |
| Visual Spec | visualSpec.ts propose/plan/apply; visualSpecContract.ts | Geometry/material/state; semantic compiler; source revision checks | Reuse accepted geometry. Missing film-wide perception and relational scale. |
| Prompt IR | promptCompiler.ts:34 compilePromptIR | Identity/preserve constraints, turnaround views, REAL_REQUIRED refusal | Later Director composition belongs before executor adapter, not a silent rewrite here. |
| Auto Asset World | autoAssetPrompt.ts:26; autoAsset.ts reconcile/worker | Composition, frozen inputs, jobs/artifacts, routing/source evidence | Brief excerpt only; no structured beats or scale. Reconcile writes, so never call from dry-run. |
| Reference Pack | characterReferencePack.ts; Studio reference-job helpers | FACE_HERO/FRONT/BACK evidence, role selection | Preserve roles. Draft image/reference does not automatically become identity Truth. |
| Studio | frontend StudioWorkspace.vue, StudioAssetDrawer.vue, studioImageReview.ts | Hero gallery, review/adoption, shared Lightbox, selected context | Keep recent interaction fixes. Night01 surface is Professional only. |
| Agent actions | studioTurn.ts; skills.ts | Semantic parsing, proposal-only skills, source version/hash checks; 5-pass extraction | No agent write path added. Director candidate is not a backdoor apply. |
| Professional | operations.ts, operationsRegistry.ts; frontend PilotShell.vue | Explicit routing/configuration inspection/apply | Executor config is separate. Avoid Comfy probes in Director reads. |
| Storyboards | frontend PilotShell.vue STORYBOARD_BATCH/resolveAssets/revision ADD; backend skills.ts | canonical→production binding; controlled semantic revision | Future intentions must compile through existing Preview/Confirm, not another writer. |
| Revision kernel | services/orchestrator/revisionConfirm.ts:218–266 | One write boundary, authorization, idempotent replay, recapture/hash/epoch, semantic apply/invalidation | Unchanged. Director acceptance is future design. |
| Image Attempt | services/productionAttempt.ts:224–250,305–393 | Source/Control preflight, supersession; ownership postflight; stale output retention; old current preserved on failure | Phase A never enters Source or invalidates generation. Future integration requires explicit hash rollout. |

## Direct evidence
Project 1790941805789310 / unit4, Creative v2/40s: 12 canonical assets, 0 active storyboards. Confirmed specs exist for CHAR-001, FX-001, LOC-002. Whale/ship/Pegasus have successful MAIN jobs but no current confirmed spec row in this capture. Their frozen inputs are in NIGHT01_FROZEN_INPUT_EVIDENCE.json; source in NIGHT01_SOURCE_EVIDENCE.json.
Frozen specs contain mostly empty scale/proportion/material/details. Descriptions repeat, followed by generic cinematic rendering. Their old composition line predates current explicit no-human isolation. Thus weak structured design evidence and historical prompt-version differences are separate findings; no causal claim about rendered quality is proven.
Current autoAssetComposition already forbids human/crew/passenger/rider in VEHICLE and unrelated humans in CREATURE. Another `no human` is not the architecture solution. Missing: DNA, emotional beats, narrative function, relational/dynamic scale, lineage and evidence-based QA.

## Minimal insertion
Existing consistent readPilot snapshot → pure Director candidate compiler → Professional inspection/exported JSON. No persist/apply, migration or generation integration. candidateHash is not B3 previewHash, production Source hash or acceptance token.

## Limits / unresolved facts
* readPilot includes project history; Phase A rejects >2MB/300 assets/300 shots after capture, but underlying history queries are not newly bounded. A dedicated bounded current-state read is needed before large-project rollout.
* Default endpoint returns unresolved null/empty semantics and warnings; no automatic director/model is claimed.
* Treatment contains an embedded “not yet applied” footer while stored Creative is v2. Preserve both; do not alter Truth based on a text footer.
* BRAND-001 category BRAND/REAL_REQUIRED has legacy assetKind OTHER. Preserve; check real-source policy by category.
* Non-human DERIVE_VIEW routing remains an independent known issue; untouched.
* No visual QA, production readiness, director acceptance or model quality claim follows from source inspection.

# OPT-MV-033A-HOTFIX-02 — Generic Structural & Common-Sense Integrity Gate

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Engineering-ready for human inspection, not asset acceptance.

## Scope and authority

A lightweight registry provides HUMAN, ANIMAL, FANTASY_CREATURE, VEHICLE, PROP, FURNITURE, MACHINE, ARCHITECTURE and GENERIC_STRUCTURED_ASSET profiles. The generic issue contract covers part count, attachment, orientation, topology, support, symmetry, perspective, material, function, contamination and cross-view continuity.

V1 uses HUMAN_INSPECTOR exclusively. No real vision model is connected or tested here, and no automatic structural detection is claimed. Synthetic observations prove decision/count rules, not recognition accuracy. Confirmed fictional structures override ordinary priors; a partially occluded visible count alone does not prove a missing part. The UI supplies immutable captured identity/Visual Spec as human evidence. Expected structural counts are not guessed from asset categories; structured count helper accepts explicitly supplied confirmed counts.

## Implementation

- assetIntegrity.ts: reusable profiles, strict issue/inspection schemas, repair decision, occlusion-aware confirmed count comparison, repair proposals.
- integritySchema.ts: additive experimental append-only inspection table. UPDATE/DELETE triggers preserve historical reports. Initialization only under DS_V04_PILOT=1.
- multiView.ts: authorized scope-bound read/record endpoints; actual MAIN/SIDE/BACK bytes checked against hashes inside source capture transaction. Input binds experimentId, sourceHash, assetRevision, visualSpecRevision and all three artifact hashes. Stale evidence rejects new recording; historical reports display STALE.
- v04/router.ts and app.ts: existing authenticated V0.4 routing and initialization integration.
- AssetIntegrityPanel.vue / MultiViewPilotPanel.vue: Professional inspection form, per-view and cross-view issues, typed-profile regions, confidence and localization, history and repair-only proposals. Generation tokens isolate project/script/experiment switches.

Results are PASS / REPAIRABLE / REGENERATE / HUMAN_REVIEW. Unreviewed/unknown observations never yield PASS. Localized problems retain identity lock and preserveOutsideRegion intent. Uncertain reports yield HUMAN_ONLY suggestions. Topology/global failure recommends view regeneration. No suggestion is executable in this ticket; preserveOutsideRegion is a proposed constraint, not proof of an inpaint implementation.

The old identity/view human evaluation remains readable and separate from structural inspection. No acceptance/adoption endpoint is added. Inspection history reads the latest 100 records; all older records remain immutable in the database.

## Engineering verification

Backend:
- node --test --test-name-pattern='INTEGRITY|MV033A' tests/v04-pilot.test.cjs: 14/14 PASS.
- node --test tests/*.test.cjs: 425 total, 419 PASS, 6 SKIP, 0 failures.
- npm run lint (tsc --noEmit): PASS.
- npm run build: PASS.

Frontend:
- node --test tests/v04-multiview.test.cjs: 9/9 PASS, including mounted issue save and late context response protection.
- node --test tests/*.test.cjs: 228/228 PASS.
- npm run build-only -- --config vite.config.ts: PASS.
- npm run type-check: pre-existing TS5103 invalid ignoreDeprecations, BLOCKED, not claimed passed.

Initial sandbox full backend/build attempts could not resolve existing dependencies outside workspace; elevated final runs succeeded. Initial mounted mocks omitted the new integrity endpoint and were corrected; final mounted tests pass.

## Runtime preservation

Same experimental data directory and existing services; backend restarted to initialize only the new experimental table. Before/after read-only comparison: all 71 existing captured tables unchanged; o_v04AssetIntegrity newly present and empty. Both historical experiments and SIDE/BACK output hashes identical. Latest experiment 9979241c-d63d-4139-9f2c-ddf884c3c69a has ready HUMAN inspection input; history count 0. No human verdict was pre-filled/saved.

Frontend SHA: 925ad18ad16b8a80e5cdf2d52f45190ff91222a7.
Stable protected references: backend 194340d6a37c6ef03a6d157f5848490f67c2e834; frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03. Only experimental branches are pushed. Existing router/types local overrides retained.

No rendering, Comfy submission, model calls, automatic repair/regeneration/adoption, Asset/VisualSpec/Director/baseline mutation, or protected database access.

## Human Pilot

Open Professional > Multi-View Pilot, select latest completed Boy experiment. Inspect MAIN/SIDE/BACK images. In Integrity section, mark only actually observed identity/view/contamination and structural review. Record BACK hand/foot issues with appropriate localization/confidence and LOCAL_REPAIR. Explicitly review cross-view continuity. Save inspection; verify BACK REPAIRABLE and repair suggestions only. Refresh to verify durable record. Do not execute repair or adopt images.

Known limits: manual observations can be incorrect; no automatic vision/pose analysis, no region mask, no repair execution. Human determines image quality. Readiness is for the human gate only.

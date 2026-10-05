# OPT-028C-HOTFIX-03 — Character Reference Pack V1 + Asset Preview Display

Status: **EXPERIMENTAL / HUMAN PILOT PENDING**. Engineering checks passed; UI visual approval pending. No generation performed.

## Patch design and contracts

- Optional strict Human Visual Spec `referencePlan`; old confirmed JSON parses as-is. New semantic compilation supplies required FACE_HERO/FULL_BODY_FRONT, recommended FULL_BODY_BACK, optional SIDE_SPECIAL_LEFT/RIGHT and DETAIL_REFERENCE. Pure fallback resolver never writes old specs.
- CHARACTER_TURNAROUND retains original four views, Identity Lock, compiler version and Review Plan `turnaroundSpec.views`. No new generation intent or change to canonical Prompt IR required. Derived `deriveCharacterReferenceIntent` and `resolveCharacterReferencesForShot` remain pure helpers, not another truth store or video executor.
- Nullable `o_v04StudioAssetDraftJob.executionPurpose` additive/idempotent migration only. No legacy backfill. Formal purposes are SUBJECT_MAIN_PREVIEW, FACE_HERO, FULL_BODY_FRONT, FULL_BODY_BACK, SIDE_SPECIAL_LEFT/RIGHT, DETAIL_REFERENCE.
- Identity: project + script + canonicalKey + purpose; revision/hash continue freshness checks. Explicit purpose and reference execution compiler version/prompt enter draftHash. Omitted purpose preserves legacy hash bytes (including old Z-Image rendering version), NULL-only supersession and old public MAIN_PREVIEW behavior.
- Supersede only same persisted purpose, including NULL matching NULL. Reuse requires same source revision/hash. Different purposes never evict each other. One request/job/artifact; explicit reference role equals purpose; SUBJECT_MAIN_PREVIEW maps to MAIN_PREVIEW. Old MAIN_PREVIEW is never upgraded to FACE_HERO.
- Existing source/config revalidation, stale late-output preservation and RUNNING-only settlement retained. No worker framework rewrite. Purpose is included in both pre/post hash checks. Reference prompts are downstream execution composition, not changes to confirmed Prompt IR.
- Frontend retains imageJobId and adds imageJobsByPurpose; scope/revision/purpose lookup and independent Drawer selection. Selected pending/failed reference does not show an unrelated old image. Card prefers a successful front/face/back draft with a role label. Context-switch guard prevents late enqueue writing new workspace.
- Pure shot routing: close-up face; front full body front+face; front medium face+front; back back; side special+face or face+front; detail prioritized when requested. Only available roles returned, default max 2. These are draft reference recommendations, not production bindings or identity guarantees.
- Card cropping root cause confirmed: fixed 125px plus cover. Subject/unknown previews now contain/center; ENVIRONMENT cover. Fixed grid height and separate caption preserved; Drawer contain unchanged. No image stretching or broad UI redesign.

## Changed implementation files

Backend: src/v04/characterReferencePack.ts (new), visualSpecContract.ts, schema.ts, studioDraftImage.ts; tests/v04-pilot.test.cjs.

Frontend: src/stores/v04ProposalWorkspace.ts; src/views/pilot/studioDraftImageView.ts, studioPresentation.ts, StudioWorkspace.vue, StudioAssetDrawer.vue; tests/v04-studio.test.cjs.

Existing backend router.ts/database.d.ts overrides preserved byte-for-byte and excluded from commit. No changes to promptCompiler.ts, Review Plan, Stable code, H3 or Comfy.

## Engineering evidence

- Backend focused `node --test tests/v04-pilot.test.cjs`: 55 total, 52 PASS, 3 optional real generation tests SKIP, 0 failures.
- Backend full `node --test tests/*.test.cjs`: 347 total, 344 PASS, same 3 SKIP, 0 failures. Real temporary SQLite and fake local HTTP producer only.
- Backend `npx tsc --noEmit`: PASS. `npm run build`: PASS.
- Frontend focused Studio + pipeline: 25/25 PASS. Full `node --test tests/*.test.cjs`: 163/163 PASS. `npm run build-only`: PASS.
- Standard frontend type-check remains blocked by pre-existing TS5103 (`ignoreDeprecations: 6.0` with installed TypeScript 5.6). First sandbox attempts also failed writing shared tsbuildinfo; normal-permission rerun isolates TS5103. Diagnostic-only command overriding the flag reveals existing unrelated project errors; it does not constitute full type-check PASS. Modified modules checked for additional errors; no configuration changed.
- Initial sandbox full backend/build failed esbuild directory access; normal-permission final run passed. Failures were not counted as passing evidence.
- New assertions cover legacy optional/new plans, pure routing, old hash bytes, per-purpose reuse/coexistence/supersession, NULL history, artifact roles, late STALE output preservation, additive upgrade twice, zero confirmed-spec/Prompt writes, scoped frontend jobs/other-purpose retention, contain/cover policy, original Drawer and layout tests.

## Runtime and human gate

Existing experimental data reused at `v04-experiment/userdata/pilot/data`; no queued/running draft jobs before restart. Experimental backend restarted using existing pilot launcher, owner read normally; frontend remains running. Backend http://127.0.0.1:10589, Studio http://127.0.0.1:50189/#/studio. Actual frontend module returned 200 and contains assetPreviewFit.

Read-only before/after logical hashes match for all rows in o_v04Asset (13), o_v04AssetVisualSpec (5), o_v04AssetPromptBuild (6), o_v04Creative (4), o_v04AgentReference (1). Only allowed additive experimental schema initialized. No old specs written or candidates promoted.

Automated reference routing: PASS. Human Asset Preview UI: **PENDING**, not PASS. Browser automation unavailable in this session. Open existing DREAM_STREAM_BRAND_PILOT_V04, Asset World -> CHAR-001. Check full head/body/feet on Card, no stretching, separate footer; open Drawer, confirm original contain behavior. Resize both panes narrow/default/wide. Do not click generation: reference routing is already tested without model calls.

Reference Pack currently supports independent draft reference roles; it does not guarantee cross-image identity, implement reference-conditioned generation or connect Shot/video production. Next hard gate is human preview/layout review, then explicit authorization for any real generation.

Stable checked before implementation:
Backend 194340d6a37c6ef03a6d157f5848490f67c2e834
Frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03

DOWNLOADS: NONE. MODEL INSTALLS: NONE. No Krea/H3/Comfy execution, no paid calls, no Stable userdata access, no merge/PR. Stop after this ticket.

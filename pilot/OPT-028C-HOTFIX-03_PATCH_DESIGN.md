# OPT-028C-HOTFIX-03 — Phase B Patch Design

Experimental only. Backend baseline 1ae6d738c076062fd2bd637ca70e7ca4329c6422; frontend 3cdca915cc95eed6a364c9a41600ee203e3fa1dc. Remote Stable checked against required SHAs and unchanged. Existing generated router/types overrides preserved.

1. Human Visual Spec gains optional strict referencePlan; new semantic compilation supplies default CHARACTER_REFERENCE_PACK_V1 plan. Reads of old specs do not add fields or persist changes.
2. Pure plan resolver supplies defaults for old specs. Required FACE_HERO/FULL_BODY_FRONT; recommended FULL_BODY_BACK; optional sides/detail; information-gain policy.
3. Keep CHARACTER_TURNAROUND and existing Prompt compiler/version/rendered four views byte-compatible. No new Generation Intent needed: executionPurpose is a non-authoritative downstream execution context. Derived referenceIntent helper, not persisted truth or retrofit into old IR/hash.
4. Persist nullable executionPurpose in existing experimental job table with additive/idempotent column only. Old NULL rows remain NULL. Omitted request purpose retains old hash bytes, legacy public inferred SUBJECT_MAIN_PREVIEW, and NULL-only supersession. Explicit purposes always hash an additional versioned purpose/execution-prompt discriminator; never supersede NULL or other purposes.
5. One purpose/request/job/artifact. For explicit character references, non-authoritative execution prompt uses existing identity facts and view/composition instruction; strips turnaround composition. Existing executor topology/sampling unchanged. Artifact role is exact requested purpose except SUBJECT_MAIN_PREVIEW maps to MAIN_PREVIEW. No existing MAIN_PREVIEW promoted to FACE_HERO.
6. Existing worker source/config freshness, STALE late-output history, RUNNING-only fail/success settlement remain; hash rechecks include persisted purpose. No worker framework rewrite.
7. Frontend imageJobsByPurpose added while imageJobId retained. Scope/revision/purpose-aware lookup and independent selection/status allow multiple current jobs. Drawer selects reference purpose and emits one request. Context switch response guard required. Card contain for subjects/unknown; ENVIRONMENT cover, neutral backdrop, unchanged height/footer. Drawer contain unchanged.
8. Pure shot resolver returns only available matching-role draft references, deterministic order and max 2. CLOSE_UP face; front full body+face; medium face+front; back back; side special+face else face+front; detail preferred. Selection is reference recommendation, not canonical promotion or video execution.

Files: backend visualSpecContract.ts, characterReferencePack.ts(new), schema.ts, studioDraftImage.ts, focused existing v04-pilot tests. Frontend studioDraftImageView.ts, studioPresentation.ts, StudioWorkspace.vue, StudioAssetDrawer.vue, v04ProposalWorkspace.ts, focused tests. PromptCompiler and Review Plan unchanged.

Tests: old/new strict specs; turnaround unchanged; pure resolver branches; real temporary SQLite migration twice; mocked producer coexistence/supersession/NULL/reuse/hash/artifact/late stale and no truth writes; frontend purpose lookup, independent maps, card fit policy, template compilation, drawer contain/layout checks. Full regression/build/type checks, then experimental service readiness only; no Comfy or model calls. Visual human verdict remains pending if UI automation unavailable.

No destructive migration, no old truth conversion, no Stable/data migration. Therefore Phase C authorized under locked boundaries.

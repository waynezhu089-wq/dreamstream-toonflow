# OPT-DIR-031B-HOTFIX-01

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Next Gate Director → Asset Design Input A/B is NOT AUTHORIZED.

## Root cause and correction

The shared Director system prompt included a project's whale and material/Logo directions. Revision preservation also relied on asset names in the instruction and omitted Studio selection. This could contaminate other projects and turn short, pronoun-based revisions into a whole-project rewrite.

Generic Director policy now contains only platform authority/semantic contract constraints. A separate experimental `directorProjectSeed.ts` defines initial directions for exact project **1790941805789310**. The seed requires its active asset keys, has a deterministic sourceHash and explicit PROJECT-scoped user-direction provenance, and is included only when no base/accepted Director exists. It is not Creative or appearance truth and has no generation consumer. Each proposal stores its seed/provenance in existing evidence; no new table, migration or canonical Director schema change.

Inputs compose current source, optional scoped seed, accepted/base content, user instruction and validated selection. Accepted/base direction takes precedence over initial seed defaults. Existing records are retained, not rewritten.

## Context and routing

`/api/v04/director/propose` accepts optional nullable `selectedObject` with PROJECT/ASSET/SHOT and bounded key. Backend validates the object against the captured project/unit. Resolution uses explicit canonical key, then unique exact asset name, then selected ASSET. Unknown keys and ambiguous multiple targets fail before model invocation. Explicit full-film/global wording selects PROJECT scope.

For a single-asset revision with a base, the server copies the base and replaces only the target Narrative Visual Role. Global DNA, other roles, unit emotion/shot intents and relations are retained. Only an explicit relationship instruction permits replacement of edges touching that target; other edges remain unchanged and strict compiler validation still applies.

Studio passes context.selectedObject. Clear narrative/emotional phrases use a small, project-independent fast path. The existing Studio semantic model can also return DIRECTOR_PROPOSAL for non-keyword narrative requests; the backend then resolves the target and creates the proposal. Pixel/appearance instructions remain on ASSET_IMAGE_EDIT. No Director JSON is assembled by the frontend. The review panel also sends its current selection.

Evidence now records requestContext (selectedObject, resolvedRevisionScope, resolvedCanonicalKey, targetOrigin) and projectDirectionSources, rather than claiming every project's direction came from one work order.

## Files

Backend: `src/v04/directorContext.ts`, `directorProjectSeed.ts`, `directorBible.ts`, `studioTurn.ts`, `studioTurnSemantic.ts`, `tests/v04-pilot.test.cjs`, this report.

Frontend: `src/views/pilot/DirectorPanel.vue`, `StudioWorkspace.vue`, `tests/v04-director-bible.test.cjs`, `tests/v04-project-agent-lifecycle.test.cjs`.

No Director database/schema/version/hash change, generation integration, Prompt IR change or Studio layout redesign. Existing router/types local overrides retain their original hashes.

## Verification

- Backend focused `node --test --test-name-pattern='DIRH1|DIR031B' tests/v04-pilot.test.cjs`: **6/6 passed**.
- Backend final full `node --test tests/*.test.cjs`: **388 total, 382 passed, 6 optional live benchmarks skipped, 0 failed**.
- Backend `node node_modules/typescript/bin/tsc --noEmit`: passed.
- Backend `npm run build`: passed.
- Frontend focused `node --test tests/v04-director-bible.test.cjs tests/v04-project-agent-lifecycle.test.cjs`: **23/23 passed**.
- Frontend full `node --test tests/*.test.cjs`: **206/206 passed**.
- Frontend `npm run build-only -- --config vite.config.ts`: passed.
- Frontend `npm run type-check`: existing **TS5103**, tsconfig.app.json(5,27), invalid ignoreDeprecations value. Not passing.

Regression evidence uses mock text models and real temporary SQLite. It covers exact project seed isolation, clean second-project model input/evidence/current/history, cross-project base refusal, accepted seed precedence, selected pronouns, explicit key/name override, global revision, unrelated-section preservation, semantic fallback, invalid selection, and mounted live selection changes across assets/projects. The actual freckles/image-edit route was reached and safely rejected for a missing image baseline, with no Director proposal or image task. An initial added test lacked its required synthetic message ID; that fixture was corrected and the final full run passed.

No live text/image model, Comfy, Krea or generation call was performed. No Human Pilot action was executed.

## Running environment and preservation

The original experimental database remains at `v04-experiment/userdata/pilot/data/db2.sqlite`. No queued/running/admitted task existed before controlled backend restart. All 70 existing non-Director tables had identical logical content hashes/counts before and after. The three Director tables remained empty. The frontend remained running; backend was restarted only to load this hotfix. Protected historical DB was not accessed.

Studio: http://127.0.0.1:50189/#/studio. Backend: http://127.0.0.1:10589. Professional: http://127.0.0.1:50189/#/professional.

## Human Pilot

1. Select whale and say “它还是有点太可爱了，我希望更庄严、更有敬畏感，但不要像怪兽。” Review whale role only; existing global DNA, other roles, lineage and unit projection remain unchanged when a base exists.
2. Select boy and say “给他加点雀斑。” This belongs to image editing, not Director. This hotfix does not automatically run that pilot.
3. Select whale and say “再有压迫感一点。” The evidence resolves the selected whale. Switch to Pegasus and test “它再神圣一点”; the old whale target must not carry over.
4. In another project, request a Director proposal. No Dream-specific default/seed should appear. Only that project's source, accepted direction and instruction should be present.
5. Existing Preview/Confirm remains required for acceptance. Director confirmation must not generate or replace images.

## Limits

The initial seed is an explicitly scoped experimental configuration, not a general seed-management UI. If its required assets are missing, it is omitted. Natural-language semantic fallback depends on the configured text model; mixed or ambiguous requests can require clarification. Exact full names/keys are supported; fuzzy name guessing is not. No human visual or live-model routing success is claimed yet. Stable baselines remain backend `194340d6a37c6ef03a6d157f5848490f67c2e834`, frontend `986fb0ff32fd257498974c6c87cf4c47f360cb03`.

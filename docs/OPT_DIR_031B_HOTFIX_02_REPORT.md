# OPT-DIR-031B-HOTFIX-02 — Proposal Lineage Finalization

EXPERIMENTAL / HUMAN PILOT PENDING. Director → Asset Design Input A/B is NOT AUTHORIZED.

## Root cause

Confirm marked only the selected proposal CONFIRMED. Its DRAFT/PREVIEWED ancestors survived, and current/read selected the newest remaining pending row. The Studio `proposal || accepted` display therefore resurrected a superseded ancestor after refresh.

## Correction

Confirm now finalizes only the selected proposal's ancestry, inside the existing writer transaction that writes Director Version and Unit Projection. Active ancestors become SUPERSEDED; rejected, confirmed and stale rows are not reclassified. Unrelated branches are untouched. Failure anywhere in finalization rolls back both lineage and accepted-version writes.

The current/read path returns only source-fresh DRAFT/PREVIEWED proposals, excluding ancestors of persisted confirmed versions even before repair. Reads do not repair/write. Preview/confirm/reject-as-active and revision from SUPERSEDED ancestry reject with DIRECTOR_PROPOSAL_TERMINAL. Confirm checks the existing accepted result before terminal guards, preserving same-hash REPLAYED and different-hash DIRECTOR_CONFIRM_CONFLICT.

An accepted Director remains the implicit base for a new revision without a pending proposal. Explicit historical CONFIRMED base references remain read-only compatibility references; they are not made active or displayed as pending. An active base is checked again after model completion to prevent late proposal generation from reviving an already finalized ancestor.

Professional history now includes paginated proposals and effective statuses, separate from Studio's active candidate. The UI filters terminal/stale proposal responses defensively and falls back to accepted state. No layout, selected routing, project seed, Director semantic contract, hash, generation or appearance changes.

## Schema and repair

The existing proposal status is TEXT NOT NULL without an enum CHECK or proposal status trigger, so SUPERSEDED requires no schema migration. Accepted Version/Projection triggers remain unchanged.

Experimental startup runs one atomic deterministic reconciliation of proven ancestors of persisted accepted versions. Metadata reads are scoped by project/unit, bounded to 10,000 proposals/versions per unit and fail closed on missing/cyclic/foreign ancestry or limits. It never supersedes every draft in a project. No background task system was added.

Actual existing project 1790941805789310 / unit 4 repair:

- P1 `37d2804b-2ba4-4488-a680-588d32bfbdb4`: DRAFT → SUPERSEDED.
- P2 `e43378fd-f59a-474d-a4c7-79e046173b7c`: DRAFT → SUPERSEDED.
- P3 `d5c35603-529f-4a17-b7ce-b75428fd3085`: remains CONFIRMED.
- Director version `b79a0985-0c92-406a-a0c7-bbd19313908e`: remains CURRENT (v1).

Only the two ancestor statuses and their updatedAt changed. Before/after full Version and Projection hashes matched; proposal content hashes excluding status/updatedAt matched. All 70 non-Director table logical content hashes/counts matched. No queued/running/admitted task existed before or after. Startup log records the two repaired IDs. Evidence files in workspace: `dirh2-lineage-before.json`, `dirh2-lineage-after.json`, `dirh2-runtime-before.json`, `dirh2-runtime-after.json`. Protected historical DB was not accessed.

## Changed files

Backend: `src/v04/directorLineage.ts`, `directorBible.ts`, `directorSchema.ts`, `tests/v04-pilot.test.cjs`, this report.

Frontend: `src/views/pilot/DirectorPanel.vue`, `tests/v04-director-bible.test.cjs`.

Original router/types overrides and unrelated untracked files remain intact.

## Engineering evidence

- Backend focused: `node --test --test-name-pattern='DIRH2|DIRH1|DIR031B' tests/v04-pilot.test.cjs`: 9/9 PASS.
- Backend full: `node --test tests/*.test.cjs`: 391 total, 385 PASS, 6 configured optional live benchmarks SKIP, 0 FAIL.
- Backend `node node_modules/typescript/bin/tsc --noEmit`: PASS.
- Backend `npm run build`: PASS.
- Frontend focused: `node --test tests/v04-director-bible.test.cjs tests/v04-project-agent-lifecycle.test.cjs`: 24/24 PASS.
- Frontend full: `node --test tests/*.test.cjs`: 207/207 PASS, including existing Studio gallery/drawer/lightbox regressions.
- Frontend `npm run build-only -- --config vite.config.ts`: PASS.
- Frontend `npm run type-check`: BLOCKED / PRE-EXISTING TS5103 at tsconfig.app.json(5,27), invalid ignoreDeprecations. Not a passing typecheck.

Tests use mock models and temporary SQLite. They verify P1→P2→P3 finalization, independent branch retention, rollback from a deliberately failing ancestor UPDATE, terminal actions, replay/conflict, concurrent related confirms and old preview rejection, dirty-history read exclusion without writes, idempotent repair, stale versus superseded history, accepted-base P4/reject restoration, and mounted refresh/terminal UI behavior. Existing 031B/HOTFIX-01 tests pass. No Comfy or image/model generation call occurred.

## Human Pilot resume

Studio remains running at http://127.0.0.1:50189/#/studio with the same experimental data; backend port 10589. Refresh: v1 should show without old candidate controls. Professional Director History should show P1/P2 SUPERSEDED, P3 CONFIRMED, v1 CURRENT. Then the user may create a new whale revision and reject it; Studio should return to v1. The agent did not execute these new Human Pilot actions.

Limits: corrupted/cyclic/foreign ancestry fails closed rather than being guessed/repaired. Large histories beyond the explicit bound require separate handling. Live browser Human Pilot remains pending. No Asset Design, image generation, Krea, Comfy, Multi-view, Visual QA or Shot Director work was performed. Stable required baselines: backend `194340d6a37c6ef03a6d157f5848490f67c2e834`, frontend `986fb0ff32fd257498974c6c87cf4c47f360cb03`.

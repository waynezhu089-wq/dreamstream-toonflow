# OPT-029B — Automatic Asset World Generation V1

Status: EXPERIMENTAL / HUMAN PILOT PENDING. No Stable changes or automatic acceptance.

## Implementation

Authenticated, owner-scoped `POST /v04/studio/auto-assets/reconcile` admits draft-ready ACTIVE AI_ALLOWED assets. REAL_REQUIRED, BRAND and UI remain reference-only. Studio invokes reconciliation on unit entry and after draft preparation; polling only reads persisted jobs. Startup resumes the existing worker.

The same SQLite write transaction captures bounded asset/job/spec/routing/Creative evidence, compiles through the existing transaction-local Prompt IR compiler and deduplicates frozen hashes. Existing confirmed baselines protect first drafts. Failed or uncertain jobs are not silently resubmitted. Explicit regeneration uses a request identity and creates a new candidate, never adopts it.

Existing jobs, artifacts and exact submitted-graph traces are reused. MAIN_PREVIEW first drafts are processed before independent CORE reference-pack roles. Each pack role starts from the same accepted baseline or successful MAIN source, with artifact/attachment identity and byte hash frozen. Source drift projects old outputs as STALE without deleting files or history.

Krea T2I wiring is operational. Non-human CORE packs use the minimal generic derive profile. A local process lease serializes GPU workers across processes. Offline/disabled admission pauses; known OOM permits one 512px retry. Unknown submission never creates an automatic duplicate `/prompt`.

Studio restores persisted images without a session-local draft, preserves subject contain fitting, exposes natural reference labels, and passes a specifically viewed candidate ID for human adoption. Adoption still requires existing Preview and Human Confirm. Ordinary edits retain baseline-first source selection. Professional Operations shows coverage and existing exact trace details.

## Verification (2026-10-06)

- Focused backend: `node --test --test-name-pattern OPT-029B tests/v04-asset-image-edit.test.cjs`: 5/5.
- Backend full: `node --test tests/*.test.cjs`: 379 total, 373 passed, 6 skipped, zero failed.
- Backend `npx tsc --noEmit` and `npm run build`: passed.
- Frontend full: `node --test tests/*.test.cjs`: 178/178 passed.
- Frontend `npm run build-only -- --config vite.config.ts`: passed.
- Frontend standard typecheck retains pre-existing TS5103. The diagnostic override is not a substitute for a passing standard check; existing unrelated errors remain.

Real current-project backfill: project 1790941805789310 / script 4. Twelve active assets: eleven AI_ALLOWED and one real reference. Ten missing first drafts were generated, CHAR-001's accepted baseline was reused, and seventeen CORE pack roles were generated. All 27 executions succeeded in approximately 1,892 seconds. Logical hashes of Asset Bible, Creative, confirmed Visual Specs/Prompt Builds, references, decisions and bindings remained identical. Missing confirmed specs used deterministic non-authoritative draft inputs from existing asset descriptions; no model created or confirmed Truth.

Local evidence: sibling `opt029b-evidence/coverage-before.json`, `coverage-after.json`, `job-matrix.json`, `real-results.json`, and 27 `*-actual-graph.json` files. These are local pilot artifacts, not bundled project Truth.

## Visual limitations and review boundary

Execution success does not mean visual acceptance. Human CHAR-001 front/back views rendered, but garment details drifted. Pegasus reference views were near-copies of the input; the ship rear view did not become a genuine rear view. Non-human view control is CAPABILITY_LIMITED. First Pegasus/ship images also included incidental people; subsequent isolated-subject prompt wording was strengthened but not regenerated in this run. Dream Matter rendered manifestations rather than a neutral swatch. Environment composition inspected successfully. These remain unaccepted draft results.

Browser automation was unavailable, so no claim of live browser visual QA. Refresh Studio, inspect restored MAIN images and CORE references, then perform normal human Preview/Confirm only if desired. No automatic canonical adoption occurred.

No downloads, installations, paid model calls, schema changes, Stable userdata access or protected DB access. A crashed lease-recovery sentinel fails closed and may require operator inspection. No general task platform was introduced.

# DS-V03-CORE-001C-A Supervisor Review

This release adds human-only Supervisor decisions. It registers `storyboard.semantic-approval` with target adapter `storyboard.semantic.v1` and Stage Gate `supervisor.storyboard-approved`. It does **not** attach that Gate to the accepted `advertisement@v2` Profile or change the V0.2 Production Kernel. AI Supervisor, `HUMAN_CONFIRM`, Skill loading, model calls, Stage reopening and production-side invalidation remain for later tasks.

## Snapshot and freshness

The server reads Storyboards for the exact `projectId + scriptId`, sorted by `index` then `id`. The canonical snapshot includes `id`, `index`, `duration`, `prompt`, `videoDesc`, `shouldGenerateImage`, parsed `productionSpec`, and sorted linked asset IDs. It excludes file paths, generation state, failure reason, output tracks and timestamps. Empty, invalid JSON or over-1-MiB snapshots fail closed. Upload provenance and readiness remain the responsibility of the existing Asset Gate.

Each immutable review stores the server-computed target snapshot/hash and exact Profile key/version plus exact Recipe key/version/definition hash when bound. `controlContextHash` hashes those exact references. History marks a review CURRENT only when both hashes and exact references match the current project; otherwise it remains STALE. An earlier review for a context that is later restored byte-for-byte is again a matching exact-context review. No automatic “latest” lookup or upgrade is used.

## API

All endpoints require normal application authentication, use POST under `/api/supervisor`, and take the current numeric project and script IDs plus the registered `reviewKey`. Clients cannot provide a target snapshot, reviewer identity or review source.

| Path | Additional input | Result |
|---|---|---|
| `/target/read` | none | Current target, hash, summary, exact Profile/Recipe and control hash |
| `/review/history` | none | Immutable rows ordered newest first, with derived CURRENT/STALE |
| `/review/decide` | `expectedTargetHash`, `expectedControlContextHash`, `decision`, `summary`, `issues[]` | Transactionally rechecks target/context and appends a HUMAN decision |
| `/gate/check` | none | Read-only result from the same resolver as the registered Stage Gate |

Human decisions are PASS or REVISE. PASS cannot contain a BLOCKER; REVISE needs at least one BLOCKER. Issues have severity, code, message, nullable suggestion and nullable evidence. The reviewer ID/name come from the authenticated server request. SQLite triggers reject UPDATE and DELETE of review records. A mismatch during decision returns `SUPERVISOR_TARGET_CHANGED` or `SUPERVISOR_CONTEXT_CHANGED` without inserting a row.

The Gate returns `SUPERVISOR_REVIEW_REQUIRED` with no current human review, `SUPERVISOR_PASS` after a current PASS, or `SUPERVISOR_REVISE_REQUIRED` after a current REVISE. Target and context failures block. The diagnostic endpoint is informational; Stage Gate checks re-read current data. Supervisor review writes no Stage, Storyboard, Asset Plan, binding, model or generated-file data.

## Human acceptance

Use disposable project data with a Storyboard row. In Production Workspace open **Advanced · Supervisor Review**. Confirm target hash, exact Profile/Recipe and `SUPERVISOR_REVIEW_REQUIRED`; submit a human PASS and confirm `SUPERVISOR_PASS`. Edit one Storyboard Prompt via the existing production UI, refresh, and confirm the hash changes, old PASS is STALE and Gate is again `SUPERVISOR_REVIEW_REQUIRED`. Submit REVISE with a BLOCKER and confirm `SUPERVISOR_REVISE_REQUIRED`. Submit a newer human PASS only after human review and confirm `SUPERVISOR_PASS`. Confirm Stage state and Storyboard content were not automatically changed and reviewer identity is shown. Human acceptance is required before calling this task ACCEPTED.

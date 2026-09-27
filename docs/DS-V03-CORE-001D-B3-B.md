# B3-B Atomic Confirm: backend operation notes

Status: engineering implementation for independent audit and human acceptance. This document does not mark B3-B, B3, D-B or 001D accepted.

## Scope and API

`POST /api/stageOrchestrator/revision/preview` remains read-only and keeps the B3-A `schemaVersion: 1` request and `previewHash`. Its response additionally returns `baseRevisionEpoch`.

`POST /api/stageOrchestrator/revision/confirm` requires the same scope, `revisionId`, `revisionKey` and `changeSet` used for Preview, plus `previewHash`, `expectedRevisionEpoch` and a non-empty `humanReason`. The server takes one SQLite write boundary, reauthorizes the current actor, replays an identical committed request if present, recaptures the Preview plan in that transaction, compares the hash and epoch, and commits the exact semantic changes, Stage/Attempt invalidation and append-only audit together. `APPLIED` and `REPLAYED` are delivery markers; replay returns the original business result. A busy writer returns `REVISION_CONCURRENT_UPDATE`; retry the **same** request and `revisionId` after the lock clears. Never generate a new ID for a transport retry.

For controlled Semantic V2 units, direct storyboard semantic mutation endpoints return `CONTROLLED_REVISION_REQUIRED`. `saveFlowData` still accepts pure layout state, while rejecting a mixed semantic save before any write. Default storyboard, Source, Supervisor and Workbench reads exclude retired shots. Explicit paged retired reads use `historyOnly: true` and `historyOffset` on `getStoryboardData` and `getVideoList` (100 rows per page). `getFileUrl` requires `projectId` and `scriptId` when `includeRetired: true`.

The owner-authorized, read-only `POST /api/stageOrchestrator/revision/history` accepts `projectId`, `scriptId`, optional `offset` and `limit` (maximum 100). It returns the stored change, impact and first committed result for that unit; it does not recalculate Preview or coordinate Stage state.

The four existing video and video-prompt worker entry points register durable `o_revisionWorkGuard` identities before model resolution, media preparation or provider calls. They settle only their own guard and target under a new write boundary. A live or uncertain guard blocks Confirm for the unit. The protected prompt, duration, video and track mutations reject competing writes. Existing image production keeps the B2 Attempt kernel; Confirm revokes affected RUNNING image Attempts according to the exact Profile DAG and retains historical/current files.

## Deployment and enablement

1. Deploy one new backend build and drain all previous backend processes, queued callbacks and unregistered workers before allowing Confirm. The service cannot infer that an old binary has stopped from an empty new guard table.
2. On a disposable copy or new environment, verify startup migration, schema, trigger absence on `o_script` UPDATE, and the actual database path. Startup explicitly runs `initializeRevisionSchema`; Preview and normal reads never migrate. Do not run these checks against the preserved B3-A human-acceptance database without a separate approved deployment plan.
3. Configure `DS_STUDIO_OWNER_USER_ID` to the ID of an existing authenticated Studio owner. There is no built-in default and no account is configured by this change. Replays and recovery require the same live authorization.
4. Keep `DS_REVISION_CONFIRM_ENABLED` unset or `false` until steps 1–3 and the route/worker coverage have been verified on the target installation. Then set it to `true` and restart only the new backend. This switch does not waive schema or runtime checks; an `o_script` UPDATE trigger makes the write boundary fail closed.
5. Use Preview and Confirm with the same `revisionId`, change set, `previewHash` and base epoch. On `REVISION_PREVIEW_STALE`, obtain a new Preview and make a new human decision. On `REVISION_CONCURRENT_UPDATE`, retry the identical Confirm, with a bounded retry count (at most three in the caller).

Do not configure a real owner, run a business database migration, restart the existing isolated service, or enable Confirm as part of source-code review.

## Recovery

An ACTIVE guard left by a crashed process remains blocking. A timeout or missing `o_video` row is not proof that the provider stopped. After independently checking the old worker and recording the reason, the configured owner may use `scripts/fence-revision-work.ps1 -ProjectId <id> -ScriptId <id> -GuardId <uuid> -Reason <reason>`; the script prompts for a session token without placing it in command-line arguments. FENCE revokes database write authority and records the old state, owner and reason. It does not cancel the provider or remove task files. Repeat Preview after fencing, then make a separate Confirm decision. Never delete guard rows to unblock a unit.

## Coverage and limits

| Path | B3-B behavior |
| --- | --- |
| Preview/Confirm | Shared transaction-local planner; Preview zero-write, Confirm one atomic write transaction and append-only result |
| Stage/Supervisor | Current epoch checked at write and Review Gate; old V2 PASS cannot revive after A→B→A |
| Storyboard legacy writers and Agent service | Controlled V2 semantic writes rejected; Legacy retains its existing path |
| Workspace and active readers | Pure layout stored, semantic truth read from active DB rows; retired shots excluded by default |
| Image generate/attach/Composite | Existing B2 producer/kernel retained; affected RUNNING ownership revoked, late callbacks cannot publish |
| Video and video-prompt workers | Durable UNIT-scope guard before input preparation; conditional settlement; explicit FENCE recovery |
| Track/video reads and writes | Managed empty tracks become historical; old selected video/prompt is labelled historical after an epoch change; current selection requires a successful current guard |
| Script asset extraction | Legacy asynchronous extraction is refused for controlled V2 before its first write or model call |

The video guard proves revision-write ordering and ownership only. It does not add B2-level video/audio Source freshness or a general media task platform. Historical outputs remain stored. The frontend Confirm workflow belongs to B3-C. No paid model, Comfy, OSS or production database calls are part of the automated tests.

Validation uses `node --test tests/*.test.cjs`, `node node_modules/typescript/bin/tsc --noEmit --incremental false`, and the repository's `scripts/build.ts`. Test fixtures use temporary SQLite. On this Windows sandbox, `tsx`/esbuild must run outside the filesystem sandbox because the sandboxed process cannot resolve `os.userInfo()` or traverse the worktree for bundling; no source or dependency change is needed for that environment-specific condition.

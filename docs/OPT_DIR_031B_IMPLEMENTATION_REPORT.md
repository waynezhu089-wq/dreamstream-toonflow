# OPT-DIR-031B — Director Intelligence Phase B

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Generation influence: **false**.

## Scope and architecture

Project Agent in Studio can propose a Director interpretation, revise a pending proposal through natural language, preview its changes, and accept it through explicit human confirmation. Studio renders readable roles, emotional beats and relationships; Professional exposes separate current/history/raw inspection without manual JSON writes.

The Project Director Bible contains global visual DNA, narrative visual roles, scale hierarchy and transformation/composition lineage. The linked unit projection contains emotional arc and shot dramatic intents. These are independent of Creative, canonical identity, confirmed appearance, Prompt IR and production ownership. No generation consumer reads this layer.

Text model output uses a normal text response with one extracted JSON object, then the existing strict Director compiler. The provider is not trusted as the canonical serializer. Targeted single-asset revisions preserve the other sections and other assets' roles on the server.

## Persistence and HTTP

Experimental startup alone initializes three tables: `o_v04DirectorProposal`, `o_v04DirectorVersion`, `o_v04DirectorProjection`. Startup is gated by DS_V04_PILOT=1 after DB readiness. No backfill. Accepted contents and deletions are protected by SQLite triggers; status changes are constrained. Repeated initialization is tested.

Authenticated `/api/v04/director/*` endpoints:

- propose: projectId, scriptId, optional userInstruction, baseProposalId, baseDirectorVersion.
- preview: projectId, scriptId, proposalId.
- confirm: projectId, scriptId, proposalId, previewHash.
- current: projectId, scriptId.
- history: projectId, scriptId, optional limit (maximum 50), offset.
- reject: projectId, scriptId, proposalId.

Actor comes from authentication and project ownership is checked again inside the service, including replay. Capture uses the caller's transaction. Confirm acquires its write boundary before recapture, verifies freshness and preview, and atomically writes an immutable project version, linked unit projection, supersession and confirmed proposal. Same proposal/hash replay returns the original versions; conflicting replay is rejected. Busy responses retain the same command for retry.

Source evidence includes project Creative units, active asset revisions/relationships, effective confirmed specs, Asset Bible reference metadata and current-unit storyboard semantics. It excludes image bytes and production image ownership. Source/candidate/preview hashes are independent Director identities. A real BRAND/UI composition target requires its confirmed Asset Bible reference. Physical brand/UI transformation remains rejected. Linked reference does not become production binding.

## Engineering verification

- Backend focused: `node --test --test-name-pattern=Director tests/v04-pilot.test.cjs`: 4 matching tests passed (other tests filtered).
- Backend full: `node --test tests/*.test.cjs`: 386 total; 380 passed, 6 configured optional live benchmarks skipped, 0 failed.
- Backend `npx tsc --noEmit`: passed.
- Backend `npm run build`: passed.
- Frontend focused: `node --test tests/v04-director-bible.test.cjs`: 4/4 passed.
- Frontend full: `node --test tests/*.test.cjs`: 204/204 passed.
- Frontend `npm run build-only -- --config vite.config.ts`: passed.
- Frontend `npm run type-check`: blocked by existing TS5103 at tsconfig.app.json(5,27), invalid ignoreDeprecations value. Not reported as passing.

Tests use mock text output and real temporary SQLite/HTTP for persistence, concurrent replay, stale source, rollback, authorization, reference/cycle rejection and immutable history. Mounted UI tests cover readable review, context races, duplicate clicks, frozen retry, and successful-confirm/read-failure recovery. No live text/image/model call was performed for engineering verification.

## Runtime preservation

Existing experiment database reused at `v04-experiment/userdata/pilot/data/db2.sqlite`. Before restart, no queued/running/admitted task was found. After controlled experimental backend restart, all 70 pre-existing table content hashes/counts matched the before snapshot, and the three new Director tables contained zero rows. No live proposal, preview or confirm was executed. Router/types local overrides retain their pre-task hashes. Shared node_modules junctions explain the Documents dependency paths; application process ancestry and logs identify the experimental checkout/data.

Studio remains at http://127.0.0.1:50189/#/studio, backend port 10589; Professional at http://127.0.0.1:50189/#/professional.

## Human Pilot steps

1. Open the existing project in Studio. Ask Project Agent “请帮我整理整部片子的导演视觉方向”. Verify proposal wording is an interpretation and current images remain unchanged.
2. Review global DNA, whale awe/sublime role, shared material lineage and Pegasus-to-real-Logo composition resolution. Reject an unsuitable proposal without changing other truth.
3. Ask “鲸鱼不要太恐怖，更偏敬畏感” or revise the proposal in the Director panel. Compare the role diff; unrelated roles and global direction must remain intact for a targeted revision.
4. Select adopt, inspect Preview, then explicitly confirm. Verify version 1 and a unit projection appear, with no image change or generation task.
5. Refresh/reconnect: accepted version and any pending candidate restore. Revise and confirm again: version 2 replaces current interpretation while version 1 remains in Professional history.
6. Change an authoritative source through its existing human workflow only if desired; reload Director and verify stale warning, with no automatic regeneration. Do not treat stale interpretation as new truth.
7. Keep image generation and Director-to-Asset A/B testing out of this pilot.

## Limits and stop

Human visual/UI pilot has not been performed by the agent. Director-specific Agent routing is on the Studio turn path; Professional has inspection rather than a separate Director chat writer. Freshness is conservative: Creative changes in another unit can stale the project Bible. Source limits fail closed at 100 Creative units, 200 references and 2 MB, but the reused readPilot read graph still captures its existing histories before the size check; large-history optimization is not claimed. Natural-language interpretation remains human-reviewed; evidence origin labels do not prove every inferred sentence. No generation connection exists.

Stable required baselines: backend `194340d6a37c6ef03a6d157f5848490f67c2e834`, frontend `986fb0ff32fd257498974c6c87cf4c47f360cb03`. Protected historical DB was not accessed. No PR, merge, force push, Comfy, Krea, image generation or accepted 001E change. Next Gate Director → Asset Design Input A/B is **NOT AUTHORIZED**.

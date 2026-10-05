# OPT-029A-HOTFIX-01 — Uploaded Editing Baseline + Agent-only Studio

Status: EXPERIMENTAL / HUMAN PILOT PENDING

## Scope and implementation

Only dreamstream/v0.4-project-agent-pilot. No schema changes, new image subsystem, fake successful generation job, production binding replacement, canonical identity modification, confirmed Visual Spec change, Prompt IR change, or accepted 001E modification.

Root cause: accepted attachment references were not executable source bindings. Capture selected successful Draft artifacts and preferred any recent image candidate. Studio continued to show technical purpose controls. The fix separates explicit continuation from durable baseline authority.

The existing o_v04Decision table now records accepted ASSET_EDIT_BASELINE decisions. Each decision ID is the binding version and supersedes only the previous decision for this project/script/canonicalKey/reference responsibility. Original o_v04AgentAttachment storage remains the source, including original upload ID, name, MIME, content SHA-256, dimensions/format, confirmed timestamp, source category, asset revision and previous version. There is no fabricated Comfy job for an import. Existing reference registration is reused as an ASSET_BIBLE reference, never as a production asset.

Preview reads only, validates actual bytes and binds scope, target revision, exact attachment/hash, role and previous binding version. Confirm obtains the SQLite write boundary, rechecks the plan in the same transaction and records the binding/reference atomically. Duplicate hash-bound confirmation replays the existing result; it never restores a superseded binding. Changed asset/scope/hash/version rejects. Preview and ordinary upload are not Apply.

Authenticated existing router ownership checks apply to all new APIs:
- POST /api/v04/studio/image-baseline/current
- POST /api/v04/studio/image-baseline/preview
- POST /api/v04/studio/image-baseline/confirm

Explicit upload-baseline requests are handled before optional vision/text invocation. No available vision is required to bind a user-specified picture. A binding is not an automatic certification that the picture matches confirmed text; the confirmation notice explicitly preserves text and production state. Generic natural-language “confirm” never applies an arbitrary recent picture: this implementation uses the visible image/asset Confirm button.

## Source selection / freshness

1. Explicit controlled sourceAttachmentId for this edit only.
2. Explicit parentCandidateId continuation, unless the user returns to baseline.
3. Confirmed task-suitable baseline: FACE uses face/general/front; BACK uses back/general/front; BODY uses general/front.
4. Compatible existing Reference Pack / MAIN_PREVIEW artifact.

Any recent unaccepted candidate no longer wins implicitly. Setting a baseline, accepting a candidate, returning to baseline text, and the return-to-baseline button clear continuation state. Explicit old-candidate Continue remains a deliberate branch. Face/back bindings coexist with the general/full-body baseline.

Capture freezes source type/ID/hash, baseline version/role, optional parent, external reference hashes, asset revision, confirmed spec evidence, executor/workflow version and actual execution parameters. Source bytes are validated against the stored upload receipt before enqueue and sent by the server to Comfy; the client has no arbitrary path/URL read capability.

Worker, candidate projection and adoption use the same currentness predicate. Only the relevant selected baseline change invalidates a new dependent candidate. Historical SUCCEEDED records and old files are preserved. Existing pre-hotfix snapshots remain readable. If a previously submitted prompt is recovered after a baseline switch, its history/output is still collected and retained as STALE with zero resubmission. No global FACE/FRONT/BACK cancellation or historical status rewrite.

Explicit candidate adoption registers its generated reference and corresponding baseline in the same existing accept transaction, so the displayed adopted result and subsequent default source agree. Generated candidates retain their honest source category; uploads are not labeled as Comfy generated.

Style reference stays separate: subject baseline A supplies pixels/identity; external B supplies only the requested style/light/material/etc. No promise of perfect identity locking is made.

## Studio / Professional

Studio hides the attachment technical-purpose selector and visual-provider configuration buttons. Professional keeps the original reference promotion APIs and controls. Existing Reference Pack generation buttons in the Studio drawer now place a natural-language request in the Agent composer instead of directly invoking a technical purpose workflow.

The baseline confirmation shows the actual image, asset name, impact notice and Confirm/Cancel. Confirm is disabled until its image loads. New candidate cards use asset names and natural labels. Card and Drawer both use the same current baseline before the old accepted/MAIN image, with independent role-specific selection. Polling/fetch and confirmation results are generation-guarded across project/script changes.

An attachment-only Studio message is persisted as conversational reference without model calls, redraw or binding. Ordinary discussion cannot apply a baseline. Known failures remain visible; no fallback to a new paid provider.

## Changed files

Backend:
- src/v04/assetImageBaseline.ts (new)
- src/v04/assetImageEdit.ts
- src/v04/assetImageEditContract.ts
- src/v04/studioTurn.ts
- src/v04/router.ts
- tests/v04-asset-image-edit.test.cjs
- pilot/OPT-029A-HOTFIX-01.md

Frontend:
- src/views/pilot/ProjectAgentPanel.vue
- src/views/pilot/StudioWorkspace.vue
- src/views/pilot/StudioAssetDrawer.vue
- tests/v04-image-baseline.test.cjs (new)

Backend implementation commit: ce3fe84b8b651f5f7bb2d99e8c4a1f067d66fde5. Frontend experimental commit: b9e7d51e829d5065e5d0a6e9137b1f1ca8604745. The final backend documentation commit is recorded in the delivery/completion manifest. Only related files are committed; existing router/types local overrides are retained unchanged.

## Engineering evidence

Backend:
- node --test tests/v04-asset-image-edit.test.cjs tests/v04-pilot.test.cjs: 78 total, 73 PASS, 5 SKIP, 0 FAIL.
- node --test tests/*.test.cjs: 370 total, 365 PASS, 5 SKIP, 0 FAIL.
- npx tsc --noEmit: PASS.
- npm run build: PASS.

Frontend:
- node --test tests/v04-image-baseline.test.cjs tests/v04-studio.test.cjs: 22/22 PASS.
- node --test tests/*.test.cjs: 173/173 PASS.
- npm run build-only: PASS (54.63 seconds).
- npm run type-check: BLOCKED by existing TS5103 ignoreDeprecations configuration; sandbox also rejected writes to shared dependency .tmp build metadata. No claim of global type-check PASS.
- Diagnostic vue-tsc with ignoreDeprecations 5.0, composite=false and incremental=false still reports existing errors outside the modified Pilot files; no modified Pilot file errors reported. Configuration and unrelated files were not changed.

Initial unprivileged full regression/build attempts hit subprocess/directory sandbox permissions. The permitted reruns produced the results above; failed attempts are retained in local logs, not represented as passes.

Regression uses actual HTTP router calls, real temporary SQLite, injected test authentication context/mock text provider, actual compiled Vue mounted components and click/input interactions. It covers upload versus confirm, zero-write preview, idempotency/concurrent confirm, stale hashes/scope/revision, imported pixel/hash capture, module reload recovery, no latest-candidate takeover, explicit V1-to-V2, return-to-baseline, style separation, independent roles, resumed late output, legacy MAIN/Reference Pack/adoption, Studio versus Professional, cancel and late scope response. It is not merely a source-string test suite.

## Real local execution

Command:
DS_OPT029AH1_REAL=1 node --test --test-name-pattern="HOTFIX-01 real uploaded" tests/v04-asset-image-edit.test.cjs

Result: 1/1 PASS. Upload -> Studio baseline preview -> Confirm ran through the actual router on an isolated HTTP test server and temporary SQLite. Authentication context and text intent are test-injected; this is NOT a real logged-in Studio Agent model/browser end-to-end claim.

Import/confirm created no Comfy job. One subsequent real local Krea2 edit completed successfully, 68.688 seconds measured around worker/result/lineage verification. No new models, nodes or topology were installed/changed. Existing Krea2 edit profile, sampler and model files were reused.

Source upload ID: 163912c8-c1de-4ed3-a7ea-5942af616d06
Source SHA-256: 6af9472e947be65e82e9aced049125cddb867d099103c0c78ea5aa10e229d41b

Full source snapshot, actual Comfy prompt ID, candidate job/output and explicit child lineage:
../../opt029ah1-evidence/real-worker.json
Actual output:
../../opt029ah1-evidence/uploaded-baseline-edit.png

The next child was admitted against the returned V1 candidate to prove lineage, without an unnecessary second real render. External-reference real executions from OPT-029A remain comparison evidence; this round reran their path with mock Comfy/real DB regression, not a claimed second real style render.

Observed image: full boy visible, black short hair, light sleepwear and bare feet; identity fidelity remains Human Visual Review PENDING. No peak VRAM measurement or production-quality guarantee is claimed.

DOWNLOADS: NONE
INSTALLS: NONE
PAID MODEL CALLS: NONE

## Runtime / protection

Experimental backend http://127.0.0.1:10589; frontend http://127.0.0.1:50189/#/studio; Comfy http://127.0.0.1:8188.
Same existing experimental data directory:
C:\Users\zhuxu\.codex\.chatgpt-projects\g-p-6aad07feb85881919315c4ff20ce40c8\v04-experiment\userdata\pilot\data

Read-only Windows current-directory metadata verified the prior backend process actually ran v04-experiment/backend. Its apparent Stable loader path was the shared node_modules junction. With cwd/PID/zero-active-job guards, only this experiment backend was restarted; existing frontend/Comfy stayed running. Final listener PIDs: backend 41252, frontend 48312, Comfy 46168. The frontend module returns HTTP 200 and contains the new baseline confirmation path; the new backend route correctly returns HTTP 401 without authentication. No credential extraction, JWT fabrication or approval bypass.

Root experiment logical before/after hashes match for captured Asset, Visual Spec, Prompt Build, Decision, Reference, Draft Job and Artifact tables; no fixture reset or silent baseline import. Evidence: ../../opt029ah1-evidence/runtime-before.json and runtime-after.json. The sample Krea image was used only in the temporary test database, not automatically applied to the Human Pilot project.

Stable refs checked and unchanged:
Backend 194340d6a37c6ef03a6d157f5848490f67c2e834
Frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03

No Stable userdata or protected historical db2.sqlite read/write. No PR, merge, force push, control-repository change, new image/video production route, video generation or production acceptance action.

## Human Pilot

http://127.0.0.1:50189/#/studio?projectId=1790941805789310&scriptId=4

1. Select the boy, upload the satisfactory Krea full-body image and say: “以后以这张作为这个男孩的基准图。” Inspect the picture and asset name, then click 确认使用.
2. Say: “保留这张图的人物和睡衣，改得更写实一点。” Wait for the image candidate; current truth is not silently replaced.
3. Click the candidate's 继续修改 and say: “这个方向对了，但眼睛再自然一点。” The V2 uses this candidate, not the old Z-Image source.
4. Reload and inspect the card/Drawer/current baseline; use 回到基准图 to leave the continuation branch.

The existing browser automation limitation remains: no live logged-in browser Human Pilot is claimed. Mounted UI/HTTP/real executor evidence is complete; human creative judgment and explicit confirmation remain yours.

Stop here. EXPERIMENTAL / HUMAN PILOT PENDING.

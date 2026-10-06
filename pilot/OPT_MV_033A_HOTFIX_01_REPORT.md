# OPT-MV-033A-HOTFIX-01 — Single-Subject Side Derivation

Status: EXPERIMENTAL / HUMAN PILOT PENDING — compile-only human gate.

Human evidence establishes a SIDE composition failure (three copies), while identity and BACK passed. Positive-channel sheet wording is a plausible activation cause, not a proven model-internal cause.

Only SIDE compilation changes. SIDE uses multiview.krea2-boy.side.2; the capture/source version remains multiview.krea2-boy.1 so sourceHash and seed remain unchanged. No workflow, model settings, worker, frontend, schema or truth changes.

## New SIDE prompt (98 words)

Preserve exactly the same boy from the supplied reference image. Rotate this same boy into one clear left-profile standing view. Replace the current frontal presentation; only the transformed side-oriented boy remains visible. Keep the same apparent age, face identity, hairstyle, body proportions, clothing construction, sleeve and shorts length, footwear state, colors, materials and distinctive details. Exactly one person and one body in the entire image. Single centered full-body standing figure. Do not duplicate the character. Do not show additional poses or copies. Do not keep the original front-facing figure visible. No extra people, animals, props, accessories or text.

## Compatibility evidence

Pinned pre-hotfix compiler: 82514434169676dcf4762644dba5384acddbab35. Regression compares exact BACK brief, prompt/hash and workflow, identical source identity/preservation and seed. SIDE graphs differ only at prompt node using identical job identity. The real existing source capture also retains sourceHash, source object, seed and BACK JSON/prompt/hash. No new persisted experiment or rendering was performed.

Existing experiment 11beb3c3-172f-4552-93d1-a516513e6380 retains SIDE FAIL/BACK PASS human evaluation and both artifacts. Read-only before/after evidence is retained locally.

## Engineering evidence

- Backend focused: node --test --test-name-pattern=MV033A tests/v04-pilot.test.cjs — 12/12 PASS.
- Backend full: node --test tests/*.test.cjs — 423 total, 417 PASS, 6 SKIP, zero failures.
- Backend npm run lint (tsc --noEmit): PASS. Initial unreachable SIDE branches caused TS2367; corrected without altering BACK values, final check passes.
- Backend npm run build: PASS.
- Frontend full: node --test tests/*.test.cjs — rerun 226/226 PASS. Initial run had one existing elapsed-time expectation failure (00:3 versus 00:40); source/tests unchanged, original log retained.
- Frontend npm run build-only -- --config vite.config.ts: PASS.
- Frontend npm run type-check: blocked by existing TS5103 ignoreDeprecations configuration; not claimed passed.

Frontend remains 22de015b75fbd98992eaaf9a0128c7290c809556. Stable backend 194340d6a37c6ef03a6d157f5848490f67c2e834 and frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03 are outside this change.

No real rendering, Comfy calls, downloads, installs, adoption or protected database access. Tests use fake Comfy/temporary data. Next: compile a new Boy Multi-View experiment and review SIDE prompt only; do not render until human approval.

## Runtime verification amendment

Backend restarted on the same experimental data directory; frontend stayed running (PID 16944). Backend listener PID 50800. No queued/running jobs were present. The historical experiment's evaluation changed during the task, already before restart: BACK PASS became PARTIAL_PASS, with added human text about wrong hand/foot, evaluation timestamp and updatedAt changed from 1791280290394 to 1791280843497. This hotfix did not issue an evaluation write and does not revert it. Both SIDE/BACK artifact hashes remain unchanged; all other 70 captured tables remain byte-equivalent logical snapshots. All other experiment fields remain unchanged. Consequently history is preserved, but whole-row equality is not claimed. The latest human BACK assessment is PARTIAL_PASS.

Remote experimental and Stable heads were verified after push. Protected DB was never accessed. This report's source changes still affect SIDE only; BACK rendering defects are outside scope and require human decision.

# OPT-QA-034 — Universal Generation Quality Pipeline

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Shadow inspection only.

## Implementation and boundaries

Three separate versioned layers: `generation.structural-guard.1`, `integrity.fast-gate.1`, `integrity.vision-adapter.1`; decision engine `integrity.decision-engine.1`, persisted pipeline `integrity.pipeline.1`.

Generation Guard is integrated ONLY into newly compiled experimental MultiView SIDE/BACK prompts. It records confirmed identity/morphology input, profile resolver v2, framing, orientation constraints and hash. No invented part counts; structured count inputs are supported but the current MultiView integration does not infer counts from prose. Base prompt snapshots, source identity and sampler/topology remain preserved; final prompt/experiment hash includes the guard. Previously compiled experiment rows remain immutable and historical images are NOT attributed Guard V1.

Fast Tier 0 checks artifact bytes/hash, actual dimensions, source freshness, output success and target-view metadata. Individual files/total image bytes and decoded pixel count are bounded. Local Fast Vision is UNAVAILABLE; valid metadata therefore yields SUSPECT, never visual PASS. The adapter supports a genuine future local inspector without silently sending images to a remote provider. Only complete high-confidence supported visual checks can produce clear local/global verdicts or PASS.

External Vision uses the existing project vision model slot, compact physical inspection brief and exact MAIN/SIDE/BACK image bytes. Occlusion and confirmed fictional morphology rules apply; no Director mood judgement. It uses structured output, a 60-second timeout, zero SDK retries, safe provider/model references, correlation ID, hashes, usage when available and latency. Unknown cost remains null. Failure/malformed/low-confidence output yields HUMAN_REVIEW. No real Vision call was performed in this ticket; provider integration is mock-verified, real model usefulness awaits Human Pilot.

Existing authenticated project-scoped endpoints:
- POST `/v04/multiview/quality/fast`: projectId, scriptId, experimentId.
- POST `/v04/multiview/quality/vision`: same scope + fastReportId + confirmExternalInspection=true. Requires exact current Fast SUSPECT/UNAVAILABLE report and verified images. Immutable STARTED reservation and COMPLETED report use existing audit storage. Repeated request replays result/reservation, not another API call. An uncertain interrupted request remains HUMAN_REVIEW; no automatic recovery task or retry loop.
- POST `/v04/multiview/quality/feedback`: same scope + visionReportId + usefulness (USEFUL/PARTIALLY_USEFUL/WRONG); append-only Human feedback.

No new schema/table. Existing IntegrityIssue, profiles, profile resolver v2, repairDecision and immutable o_v04AssetIntegrity are reused. Repair proposals remain executionAuthorized=false. No repair, regeneration, adoption, production mutation or implicit API escalation. Budgets are recorded (one local repair/one whole-view regeneration), but execution is disabled.

Professional UI provides Fast action, explicit image-sharing authorization before Vision, audit details and simple human usefulness feedback. Context tokens prevent old responses from replacing another unit. Normal user surfaces do not require technical issue reconstruction.

## Verification

Backend:
- `node --test --test-name-pattern='QA034|INTEGRITY|MV033A' tests/v04-pilot.test.cjs`: 20/20 PASS.
- `node --test tests/*.test.cjs`: 431 discovered; 425 PASS, 6 SKIP, 0 FAIL.
- `npm run lint` (tsc --noEmit): PASS.
- `npm run build`: PASS.

Frontend:
- `node --test tests/v04-multiview.test.cjs`: 11/11 PASS (mounted interactions included).
- `node --test tests/*.test.cjs`: 230/230 PASS.
- `npm run build-only -- --config vite.config.ts`: PASS.
- `npm run type-check`: BLOCKED by existing tsconfig.app.json TS5103 invalid ignoreDeprecations; not claimed as passing.

Synthetic tests prove rear/side structural guards, animal/fantasy/vehicle/prop/generic routing, no invented wings and confirmed four-wing preservation, conservative unavailable/low-confidence/failed Fast policy, explicit escalation, no API on clear Fast verdict, drift rejection, Vision timeout/schema/low confidence fallback, append-only audit/replay, ownership and no authoritative data mutation. Existing fictional morphology and occlusion regressions also pass. Mounted test proves no API from Fast, explicit checkbox consent and duplicate click suppression.

## Historical Boy Phase 1

Project 1790941805789310 / script 4 / CHAR-001 / experiment b5e9b501-6657-492f-b437-c9049badd320.

Ran current service Fast Gate once against the real experimental persisted artifacts (not an HTTP acceptance claim), with external fetch forbidden. Report: 79feaa15-2875-4c93-85d7-4c2ef0c83d68.

- Guard: NOT_APPLICABLE_HISTORICAL.
- SIDE: SUSPECT; BACK: SUSPECT.
- Final SIDE/BACK/CROSS_VIEW: HUMAN_REVIEW.
- Fast pass=0; clear fail=0; external escalation=0; model calls=0.
- This is unresolved visual evidence, not detection/confirmation of any specific Boy defect.

Logical before/after comparison across 72 captured non-Director tables: ONLY o_v04AssetIntegrity changed, 4 to 5 rows (one intended append). Three existing MultiView complete logical rows and six SIDE/BACK artifact byte hashes remained identical; no active job was present. Four Director table counts stayed identical. Evidence in workspace root: qa034-before.json, qa034-after.json, qa034-history-before.json, qa034-history-after.json, qa034-preservation.json, qa034-real-fast.json.

Protected Stable DB was never accessed, copied or migrated. Existing local router/types overrides are preserved; no paid model, Comfy generation, downloads or installation occurred. Accepted 001E and Stable branches unchanged.

## Completion matrix and Human Pilot

Generation Guard core/integration, profile reuse, Tier 0, conservative policy, Vision adapter (mock), escalation-only, no API on clear Fast, fictional override, occlusion-aware and API failure fallback: PASS by engineering verification.
Local Fast Vision: UNAVAILABLE. Shadow mode and Human Pilot: READY. Real Vision accuracy/usefulness: NOT YET VERIFIED.
AUTO REPAIR: NO. AUTO REGENERATE: NO. AUTO ADOPTION: NO. HISTORY: PRESERVED.

Open Professional -> latest Boy MultiView -> Quality Pipeline. Existing Fast report should display SUSPECT. If approved, explicitly allow MAIN/SIDE/BACK external inspection and click Vision shadow inspection once. Compare actual images and report; choose Useful / Partially useful / Wrong. Failure means HUMAN_REVIEW, not PASS. Do not render, repair, adopt, or start another asset. Stop for Wayne Human Pilot.

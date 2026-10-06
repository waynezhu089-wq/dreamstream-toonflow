# OPT-QA-034-HOTFIX-03 — Vision Preflight Visibility & False-PASS Escalation Guard

Status: EXPERIMENTAL / HUMAN PILOT PENDING

## Root cause
Fast PASS was treated as an unrestricted final PASS and as a reason to hide preflight/escalation. The real local 3B model missed Human-confirmed BACK hand/foot/leg defects. Image-input success did not validate fine-structure detection.

## Change
- Current local adapter explicitly COARSE_ONLY. Reusable profile/view policy requires fine extremity, limb coherence, attachment/topology or mechanical connection checks. Coarse PASS becomes SUSPECT_FINE_DETAIL / HUMAN_REVIEW when required classes remain unverified. A future internally validated FINE_STRUCTURE_VALIDATED adapter can retain PASS through the complete/high-confidence gate.
- Results expose coarseStatus, capabilityClass, requiredCheckClasses, authoritativeFor, unverifiedFor. Current Human REPAIRABLE/REGENERATE conflicts produce FAST_HUMAN_CONFLICT. History is projected on read; original reportJson and decisions are not rewritten.
- External capability is resolved from the project model/config, independently of Fast verdict or experiment. Read uses DB model resolution and local vendor-code hash only; no provider invocation or session creation. Signature includes provider/model, vendor config/code, transport and preflight versions. Project-authorized capability cache is reusable between that project's units/experiments. READY proof is preferred over a failed alternative transport.
- Preflight request no longer requires a Fast report; it still requires explicit consent and valid image probes. STARTED/COMPLETED records retain cache/replay semantics. Config changes expose STALE. A same-signature attempted request is replayed, not silently retried; changing config or explicitly choosing the alternative transport is required for another probe path.
- Professional preflight button is visible for configured UNKNOWN/STALE/FAILED, even before Fast or after PASS. READY removes duplicate preflight need. Explicit Force Vision shadow can override a Fast PASS; consent and current READY capability remain mandatory. No automatic external calls.
- Vision reservation/replay identity binds exact input/artifact hashes, targetView, model/config signature and inspection brief version, not Fast report ID. A fresh Fast report cannot authorize duplicate spending. STARTED uncertain delivery remains non-retryable automatically.
- High-confidence Vision evidence takes precedence over coarse Fast in the shadow decision engine. No generation, repair, adoption or Project Truth changes.

## Real current Boy readonly verification
Experiment b5e9b501-6657-492f-b437-c9049badd320, existing Fast record 569e0d03-d798-49d1-9f9a-217b37f99ac8:
- SIDE: original PASS retained; effective COARSE PASS, FINE_LIMB_COHERENCE unverified, HUMAN_REVIEW; current Human decision PASS.
- BACK: original PASS retained; effective COARSE PASS, FINE_EXTREMITY_STRUCTURE unverified, FAST_HUMAN_CONFLICT, Human REPAIRABLE, HUMAN_REVIEW. Eligible for shadow when capability becomes READY.
- External model openai:qwen3.8-flash, capability UNKNOWN. Model invocation counter 0; network disabled in the readonly harness.
- Before/after logical snapshot of 72 experimental tables: no differences. Existing manual, Fast and timeout evidence retained. No new local/external inference during engineering.

## Verification
Backend focused: node --test --test-name-pattern='QA034|INTEGRITY|MV033A' tests/v04-pilot.test.cjs — 26 PASS.
Backend full: node --test tests/*.test.cjs — 437 total, 431 PASS, 6 skipped, 0 failed.
Backend npm run lint (tsc --noEmit) — PASS; npm run build — PASS.
Frontend focused: node --test tests/v04-multiview.test.cjs — 12 PASS.
Frontend full: node --test tests/*.test.cjs — 231 PASS.
Frontend npm run build-only — PASS.
Frontend npm run type-check — existing TS5103 Invalid ignoreDeprecations, BLOCKED/PRE-EXISTING, not PASS.
Tests cover readonly model state with zero provider calls; no-Fast and historical-PASS preflight visibility; READY/stale; false-PASS policy; future fine validated PASS; immutable Human contradiction projection; force-shadow consent/duplicate click and replay across different Fast IDs; existing no-mutation and historical regressions.

## Completion matrix
PREFLIGHT INDEPENDENT OF FAST: PASS
FAST CAPABILITY CLASS: COARSE_ONLY
FINE DETAIL FALSE PASS BLOCKED: PASS
HUMAN CONFLICT DETECTION: PASS
PROFESSIONAL FORCE SHADOW: PASS (mocked engineering verification, no real external invocation)
NORMAL STUDIO TECHNICAL BURDEN: NONE
HISTORY PRESERVED: YES
API CALLED DURING ENGINEERING: NO external provider API
AUTO REPAIR: NO
AUTO ADOPTION: NO
HUMAN PILOT: READY for user-run preflight only; actual provider readiness remains UNKNOWN.

## Boundaries and limits
No fine detector accuracy claim; COARSE_ONLY is not full anatomy validation. Historical evidence is displayed as original plus effective policy, never upgraded. Human evidence freshness follows exact input/hash identity. Current UI cache is refreshed by the explicit read/refresh action; backend rechecks current config before any admission. No new database schema. No paid model, local inference, Comfy, image generation or production mutation in this ticket. Protected DB not accessed. Local router/types overrides preserved. No Stable edits, PR, merge or force push.
Stable remote references to verify at delivery:
Backend 194340d6a37c6ef03a6d157f5848490f67c2e834
Frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03

Next: Wayne refreshes Professional, checks COARSE PASS / UNVERIFIED / BACK Human conflict, explicitly consents and runs qwen3.8-flash capability preflight. Do not run full inspection, repair, regenerate or adopt automatically.

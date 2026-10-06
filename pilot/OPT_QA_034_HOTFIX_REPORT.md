# OPT-QA-034 HOTFIX-01 / HOTFIX-02

Status: EXPERIMENTAL / HUMAN PILOT PENDING

## Implemented
- Provider/config-signature capability preflight: one image/plain count, one image/minimal structured, three images/minimal structured. Sequential, stop first failure, maxRetries=0; persisted STARTED/COMPLETED audit prevents duplicate automatic requests. Native versus strict JSON-text transport is explicit.
- Temporary <=512px JPEG derivatives, source hash/dimension evidence, original bytes unchanged. Full vision blocked until ready; MAIN+target for SIDE/BACK, all three only for explicit ALL.
- Local CPU adapter using pre-existing Qwen2.5-Omni-3B Q4_K_M and its Q8_0 mmproj. Six checks, strict canonical compiler; casing-only normalization, contradictory defect/verdict rejected. Incomplete/uncertain/low-confidence output cannot PASS. No external fallback in Fast.
- Isolated Python target runtime: llama-cpp-python 0.4.2+cu128 and diskcache 5.6.3. No Comfy core/site-packages changes or model downloads. Trusted server env selects PYTHON/RUNTIME/MODEL/MMPROJ/PROBE; receipt verifies successful image input and exact paths/sizes. Missing runtime fails closed.
- Per-call CPU model close and worker lease released in finally; no persistent model/GPU service. No new lifecycle/schema table.

## Real local evidence
Existing MAIN input probe: load 1074ms, inference 9140ms, subject count 1. Initial full-check failures retained; they exposed overly complex output and formatting-case mismatches. Final shadow audit 569e0d03-d798-49d1-9f9a-217b37f99ac8:
- SIDE: six complete checks, HIGH, model PASS. Load 2564ms, inference 25991ms, total 28951ms.
- BACK: six complete checks, HIGH, model PASS. Load 2911ms, inference 25750ms, total 29045ms.
- CPU only, no external calls. CROSS_VIEW overall remains HUMAN_REVIEW. These are model observations, not independent human ground truth or an accuracy benchmark. No repair/regeneration/adoption.
- Final service invocation completed and appended the audit; evidence-file creation then hit EEXIST and did not overwrite prior evidence. Actual appended row was separately read back to qa034h2-real-local-latest.json.
- The first successful image probe proves input support, not detector accuracy. Real negative/fantasy/vehicle accuracy is not validated; synthetic compiler policies are tested. CPU ~29sec/view is not sub-second Fast.

## External provider blocker
Real HOTFIX-01 external preflight NOT RUN. Automatic approval rejected sending historical project image derivatives to the configured external vision provider; an explicit <=3-request authorization question remains pending. Do not confuse mocked staged tests with real provider readiness. No full external integrity inspection was run.

## Verification
Backend: node --test --test-name-pattern='QA034|INTEGRITY|MV033A' tests/v04-pilot.test.cjs: 23 PASS.
Backend full: node --test tests/*.test.cjs: 434 total, 428 PASS, 6 skipped, 0 failed.
Backend npm run lint (tsc --noEmit): PASS. npm run build: PASS.
Frontend focused node --test tests/v04-multiview.test.cjs: 11 PASS.
Frontend full node --test tests/*.test.cjs: 230 PASS.
Frontend npm run build-only: PASS. npm run type-check: existing TS5103 ignoreDeprecations blocker; not PASS.
Initial sandbox runs produced esbuild access/TS5033 permission errors; elevated authorized verification removed those environmental errors. No dependency upgrades to the application.

## Preservation
Experimental before/after logical snapshot: only o_v04AssetIntegrity changed (7 to 14), all other 71 captured tables unchanged. Three historical MultiView rows and all SIDE/BACK byte hashes preserved. Original assets and images not rewritten. Protected isolated DB not accessed. Local router/types overrides preserved exactly. Stable remote branches verified unchanged:
Backend 194340d6a37c6ef03a6d157f5848490f67c2e834
Frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03
No image generation, Comfy execution, adoption, production binding or paid external call.

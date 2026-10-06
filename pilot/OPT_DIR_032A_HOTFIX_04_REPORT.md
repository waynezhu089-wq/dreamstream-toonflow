# OPT-DIR-032A-HOTFIX-04
Status: EXPERIMENTAL / HUMAN PILOT PENDING
RENDERED: NO

## Causal design
comparisonDesign LEGACY_VS_CLEAN_VS_DIRECTOR, compiler director.asset-control.1.
A0 reuses exact legacy autoAssetPrompt and its captured prepared spec / existing Prompt IR compilation.
A1 = asset.rendering-brief.1. It accepts ONLY canonical asset and selected existing Visual Spec, not Director. Field-level serialization preserves safe short English identity, silhouette, proportions, palettes, materials, details, anchors and preservation constraints. Source spec wins; canonical anchors used only when absent. Unknown Chinese / oversized narrative remains in captured audit evidence with omitted field path/reason; no guessed translation. Scope is CHAR-003 Whale only; not a general rollout.
B reuses identical assetRenderingBrief, cleanBasePrompt and cleanBaseHash, then appends Director delta. Delta uses director.rendering-brief.1 visual character/scale/lighting/environment only; no repeated identity, composition or anti-text. Spec scale/proportion cannot generate delta. Empty Director produces empty delta. Exact duplicate phrases already present in base removed deterministically.
Budgets: clean base <=150, delta <=100, final <=250 words. Required identity/guards are never silently truncated; oversized safe base fails closed.
Actual readonly project source: A1 68 words, delta 50 words, final B 121 words; cleanBaseHash equality true. A1 has biological whale/skin/anatomy/isolation/generic cinema/anti-text, no sublime/awe/ancient/Director scale. Delta adds sublime/ancient/majestic/awe/monumental mass/non-aggressive/night-blue/moonlight/volume illumination.

## Runtime and persistence
Existing experiment table, no SQL schema change or old record migration. A0/A1/B frozen workflows share seed and all graph topology/settings except positive text. Explicit human confirmation required. Serial A0 -> A1 -> B under existing GPU lease. Any side failure stops later sides, retains successful artifacts and settles FAILED. OOM has no side-specific fallback. Restart fences interrupted three-way states, retains succeeded sides and never resubmits.
Existing authenticated artifact endpoint accepts historical A/B and new A0/A1/B, checks bytes/hash, returns binary Blob contract unchanged.
Two strict evaluation shapes: historical two-way retained; new record requires separate hygiene and Director sections. Wrong design format rejected; incomplete/stale cannot be evaluated. No automatic winners or adoption.
UI shows three input/result columns, shared clean base and Director delta before render, raw audit collapsed, historical two-way remains two columns. Three Blob artifacts restore and lightbox works. Separate human evaluation sections and explanatory matrix shown.

## Tests (actual commands)
Backend node --test --test-name-pattern=DIR032A tests/v04-pilot.test.cjs: 19/19 PASS.
Includes current source A0 fidelity, synthetic explicit spec fact preservation, base invariance under Director changes, empty-Director delta, shared hashes, all three graph/seed equality, compile-only truth isolation, fake-Comfy serial success and failures A0/A1/B, artifact reads, retry dedupe, recovery, historical preservation.
Backend node --test tests/*.test.cjs: 410 total, 404 PASS, 6 SKIP, 0 FAIL.
Backend npm run lint (tsc --noEmit): PASS. npm run build: PASS.
Frontend node --test tests/v04-director-ab.test.cjs: 11/11 PASS.
Includes three-column gate, no auto render, confirmation duplicate guard, all-three remount Blob/lightbox, two evaluation payloads, historical two-way, hotfix02 direct Blob and scope guards.
Frontend node --test tests/*.test.cjs: 218/218 PASS.
Frontend npm run build-only -- --config vite.config.ts: PASS.
Frontend npm run type-check: BLOCKED / PRE-EXISTING TS5103 Invalid --ignoreDeprecations. Not PASS.

## Preservation and limits
Old e8386167-90c7-4471-a146-03563c9adb37 full record hash feba28953655b5799fabcb0ff928e54a688dd7a9ad44d1e776c7b3e3347913f4; A/B PNG files verified matching SHA256. Older 3920d815-5410-4abe-831d-3f9705445029 compiled input also retained. Historical read is STALE, persisted status/input/artifacts/evaluation unchanged. No rating applied to old regression.
No real Comfy/model/image generation; no current runtime experiment created during this work. Runtime compile is left to human gate, while readonly pure compiler and actual HTTP fixture prove readiness. No Director/Asset/spec/baseline/Reference Pack changes. Protected DB untouched, Stable sources/userdata unchanged, no PR. Local router/types overrides retained.
Known limit: unmapped identity prose is audited rather than guessed; review source omissions before render. Rendered quality and causal result still unknown until human authorizes and evaluates three images.
Next: Professional -> Director -> compile NEW three-way Whale input -> review A1 clean base and B delta -> authorize render only if semantic split passes. STOP.

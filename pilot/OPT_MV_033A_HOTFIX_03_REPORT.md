# OPT-MV-033A-HOTFIX-03 — Semantic Integrity Profile Resolution

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Integrity routing only.

## Root cause and fix

The previous kind-only resolver assigned every CREATURE to FANTASY_CREATURE. New resolver version integrity.profile-resolver.2 returns profile, confidence, evidence and fallbackUsed. Priority: explicit confirmed morphology profile seam, confirmed structural Visual Spec fields, confirmed identity facts, server-read canonical asset description, broad unambiguous kind, conservative generic fallback. Name-only animal evidence is supporting LOW-confidence fallback; names/canonical keys are never the primary project-specific routing rules.

Ordinary animal species/form evidence routes ANIMAL. Confirmed non-ordinary morphology overrides ordinary species priors, including horse base structure plus confirmed wings across Visual Spec/identity fields. Bird wings alone do not imply fantasy. Negated/forbidden appendages do not establish positive morphology. Unknown CREATURE returns GENERIC_STRUCTURED_ASSET / LOW. Known architecture requires structural evidence; an unspecified environment is not automatically assumed to be a building.

Only selected species/form/body/anatomy fields and confirmed identity facts are considered; Director, mood, lighting, narrative role and story context are excluded. This is bounded conservative semantic routing, not universal language understanding or automatic morphology recognition.

## Changed files

Backend: src/v04/integrityProfileResolver.ts; src/v04/assetIntegrity.ts; src/v04/multiView.ts (Integrity context/read/record sections only); tests/v04-pilot.test.cjs; this report.
Frontend: src/views/pilot/AssetIntegrityPanel.vue; tests/v04-multiview.test.cjs.

New inspection records freeze their context, resolver version and evidence in existing reportJson. No new database schema. Historical stored contexts remain original. Legacy records lacking context are explicitly labelled; no retroactive profile is fabricated. Current UI displays concise profile/confidence/evidence separately from frozen historical context.

## Real read-only evidence

Same experimental project 1790941805789310, consistent readonly SQLite transaction, server-read ACTIVE canonical facts and CONFIRMED Visual Spec only:

- CHAR-001 / 男孩: HUMAN / HIGH, confirmed Visual Spec revision 3. Boy unchanged.
- CHAR-002 / 飞马: FANTASY_CREATURE / MEDIUM, confirmed canonical description contains 有翼马; no confirmed creature Visual Spec currently exists.
- CHAR-003 / 鲸鱼: ANIMAL / MEDIUM, confirmed canonical description identifies whale morphology; no confirmed creature Visual Spec currently exists.

No model or vision calls, no generation. Result saved locally in integrity03-real-resolution.json. Real records were not changed to improve the result.

## Verification

Backend:
- node --test --test-name-pattern='INTEGRITY|MV033A' tests/v04-pilot.test.cjs: 15/15 PASS.
- node --test tests/*.test.cjs: 426 total, 420 PASS, 6 SKIP, 0 FAIL.
- npm run lint (tsc --noEmit): PASS.
- npm run build: PASS.

Frontend:
- node --test tests/v04-multiview.test.cjs: 10/10 PASS.
- node --test tests/*.test.cjs: 229/229 PASS.
- npm run build-only -- --config vite.config.ts: PASS.
- npm run type-check: existing TS5103 invalid ignoreDeprecations, BLOCKED / PRE-EXISTING.

Synthetic coverage includes biological whale, ordinary horse/no wings, Pegasus, bird/normal wings, structured appendages, cross-field confirmed fictional override, ambiguous creature, fantasy Director exclusion, unambiguous existing types, architecture evidence, explicit confirmed profile precedence, name-only lower confidence, immutable legacy context and new context persistence. Existing Multi-View regression remains passing.

## Runtime/history

Same experimental service/data directory, backend restarted to load resolver, frontend kept running. All other 71 captured table contents and all three Multi-View experiment rows/artifact hashes unchanged. During this task normal actor-1 integrity/record requests appended two inspections: count 0 -> 1 before restart -> 2 afterward. The pre-restart inspection is byte-preserved; its old report has no context, and the second new report freezes resolver version 2. These were not hotfix/test-issued writes. Whole-database equality is not claimed; no record is deleted, patched or rewritten.

Frontend commit: 66b6e135cfdccde2c53c54f78f51cbe883b2da32.
Stable protected refs: backend 194340d6a37c6ef03a6d157f5848490f67c2e834; frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03. Existing router/types overrides preserved. No Stable userdata access, downloads, installs, model calls, rendering, repair, adoption, truth/Visual Spec/Director/baseline changes. SIDE/BACK prompts, seed, model settings and workflow unchanged.

## Stop / Human Pilot

Semantic resolver and evidence: engineering PASS. HUMAN / ANIMAL / FANTASY_CREATURE / VEHICLE / generic fallback / uncertainty tests PASS. Director leak NONE. Boy regression NONE. History preserved YES. Human Pilot READY, with no automatic inspection claim. Read-only real Whale/Pegasus checks completed; wait for human decision. Do not generate either asset or repair Boy.

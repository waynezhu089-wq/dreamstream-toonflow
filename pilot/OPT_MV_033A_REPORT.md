# OPT-MV-033A — Krea2 Identity-Locked Boy Multi-View Pilot

Status: EXPERIMENTAL / HUMAN PILOT PENDING. Engineering compile/interaction gates only; no real rendering or visual acceptance.

## Source verified on the disposable pilot

Project 1790941805789310 / script 4 has exactly one ACTIVE HUMAN_CHARACTER named 男孩: CHAR-001, asset revision 2. The resolver uses current assets and name evidence, not a hardcoded canonical key. Multiple boy matches fail MULTIVIEW_TARGET_AMBIGUOUS.

The current accepted GENERAL baseline is decision 3f0b5267-8e53-48aa-9703-36e9b02aa137, attachment 5e8af0fd-ddd6-4439-a0f8-d03066392880, original artifact ebf5edec-7766-4c9a-8592-c8acf642ebad. Source SHA-256: 0066791016eecd6eeb9c26c7d18117ebef0a7da37fdada2476041aa08fa8e65c. Source size 768×768, confirmed Visual Spec revision 3. Visual inspection of this existing file shows one complete boy, white short-sleeve top, white shorts and bare feet. No new hero was made.

Source order: current accepted FULL_BODY_FRONT → current accepted GENERAL → successful, current, fresh MAIN_PREVIEW. Fallback never selects FACE_HERO, pack views, stale/cancelled/failed jobs, rejected edit candidates or other units. Main job freshness reuses autoJobFresh, or exact current spec/Prompt IR comparison for legacy jobs. Actual file bytes are verified; source hash, baseline version, asset and Visual Spec evidence, route and local origin enter immutable experiment identity. Unreadable current accepted sources fail closed, without resurrecting an older baseline. Source quality (complete subject, single subject, unobstructed) remains an explicit Human checkbox; file checks are not visual QA.

## Architecture / isolated boundaries

MultiViewViewBrief → deterministic Krea view prompt → existing buildKreaEditWorkflow. Route must resolve to KREA2_DERIVE_CHARACTER_REFERENCE_V1 and executor must be enabled; unsupported/disabled routes fail MULTIVIEW_ROUTE_UNSUPPORTED, never T2I fallback.

Both direct views use the same MAIN image (STAR), same frozen seed and graph settings. Prompts refer to the image for clothing and identity authority; old long-sleeve/pajama prose is audit evidence, never a redesign instruction. Current identity anchors/must-preserve/forbidden-changes remain recorded. No Director role, narrative, DNA or delta module is invoked.

Frozen builder values: krea2_turbo_fp8_scaled.safetensors / qwen3vl_4b_fp8_scaled.safetensors (CPU CLIP) / qwen_image_vae.safetensors / krea2_identity_edit_v1_2.safetensors, LoRA strength 1; 768×768, 8 steps, CFG 1, euler/simple, denoise 1, fit mode fit, ref_boost 4, ref_boost_a 1. Workflow krea2-identity-edit-1.2-fit-v1. No topology/model/parameter changes. Seed supports control, does not establish identity.

New o_v04MultiViewExperiment is an experimental-only record, initialized only with DS_V04_PILOT=1. Immutable compiled payload; mutable status/execution/Human evaluation. Production/001E tables and semantics unchanged. Private experimental artifact roles EXPERIMENTAL_MULTIVIEW_SIDE / EXPERIMENTAL_MULTIVIEW_BACK; no Studio draft jobs, attachment promotion, accepted baseline or Reference Pack writes. Existing trace and GPU lease reused.

Authenticated APIs /v04/multiview/{compile,current,render,evaluate,artifact}. Ownership and exact project/script checked. Compile only inserts an experiment, never submits or uploads to Comfy. Render requires exact experimentHash, confirmRender=true AND sourceQualityConfirmed=true; one admission per experiment, replay returns existing state. SIDE then BACK, both from MAIN; no auto retry. Side failure stops Back to avoid unresolved GPU work. Back failure retains Side. Interrupted restart marks uncertainty without rerender. Completed/partial images remain readable; stale records cannot render or receive effective new QA.

Fallback contract is proposal-only: MAIN + Human-passed SIDE, maximum one future attempt, separate authorization. No fallback execution/adoption API exists.

## Professional surface

Multi-View Pilot is a separate Professional tab. Source image, both readable briefs and compact prompts visible; hashes/model metadata/graph folded. Compile has no render side effect. Human must review source and prompts then open and confirm a second render dialog. Busy/duplicate guards and scope generations protect late compile/render/Blob responses. Blob downloads restore MAIN/SIDE/BACK after remount; lightbox uses the existing component. Human PASS/PARTIAL_PASS/FAIL records only; no adoption controls.

Readonly actual-project compiler probe returned SIDE 91 words and BACK 104 words (hard cap 200). No real experiment was inserted by this probe, and no model or Comfy request was issued. Human can compile the persisted record in Professional. The first gate is prompt review, NOT rendering.

## Engineering verification

- Backend focused: node --test --test-name-pattern=MV033A tests/v04-pilot.test.cjs — 11/11 PASS.
- Backend full: node --test tests/*.test.cjs — 422 total, 416 PASS, 6 SKIP, 0 FAIL.
- Backend npm run lint (tsc --noEmit) — PASS.
- Backend npm run build — PASS.
- Frontend focused: node --test tests/v04-multiview.test.cjs — 7/7 PASS.
- Frontend full: node --test tests/*.test.cjs — 226/226 PASS.
- Frontend npm run build-only -- --config vite.config.ts — PASS.
- Frontend npm run type-check — BLOCKED / PRE-EXISTING TS5103 Invalid --ignoreDeprecations; not a passing type check.

Initial sandbox backend full run had 410 PASS/6 SKIP/4 esbuild access-denied failures; first backend build failed uv_os_get_passwd ENOMEM, frontend build failed esbuild directory access, and initial frontend type check also had cache EPERM. Authorized unsandboxed reruns resolved access failures. Added route test initially omitted the existing routing Preview/Confirm fields; fixture corrected to use the existing normal preview/apply contract. No production behavior was weakened to pass tests.

Real temporary SQLite and actual Express router tests cover authentication, source priority, wrong scope, stale/rejected/purpose filtering, baseline/Visual Spec drift, unsupported routing, compile truth isolation, pinned settings and STAR inputs. Only fake local Comfy verifies serial submission, full frozen traces, independent terminal results, no adoption/retry, artifact reload, interrupted restart. Real image quality is NOT tested yet.

## Human gate / stop

SOURCE RESOLUTION: PASS (current disposable project).
IDENTITY LOCK / STAR / SIDE BRIEF / BACK BRIEF / SAME SETTINGS / GENERATION ISOLATION: engineering PASS.
ANGLE POLICY: TOLERANT. DIRECTOR LEAK: NONE. REFERENCE PACK MUTATION: NONE. RENDERED: NO.

Open http://127.0.0.1:50189/#/professional → Multi-View Pilot → compile Boy → review MAIN/SIDE/BACK prompts. Do not render until Wayne approves. No Pegasus, Ship, Qwen download, Shot Director or formal rollout. Stable backend 194340d6a37c6ef03a6d157f5848490f67c2e834 and frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03 must remain unchanged. No protected database access, no paid model, no downloads/installations, no PR.

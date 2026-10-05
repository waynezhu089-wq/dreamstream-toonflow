# OPT-029A — Agent-First Asset Image Editing

Status: EXPERIMENTAL / HUMAN PILOT PENDING
Date: 2026-10-05
Product principle: Complexity belongs in the execution layer. The user expresses intent to Project Agent and reviews candidates.

## Implemented behavior

Studio uses its existing persistent project conversation for plain messages and messages with image attachments. The semantic turn can produce ASSET_IMAGE_EDIT, while discussion and existing proposal paths remain available. Target must match an explicit current-project asset mention or selected asset. Ambiguous targets and reference purposes trigger a natural-language question.

The resolver captures asset revision, confirmed Visual Spec evidence, a persisted source artifact and its bytes hash, optional scoped conversation references and provenance, preserve intent, workflow/model versions, seed and parameters. No model-specific data enters Project Truth, Visual Spec or Prompt IR. Sources prioritize appropriate Reference Pack roles, with MAIN_PREVIEW as a draft fallback. Continued editing uses the preceding successful candidate; explicit history selection pins that parent.

Existing o_v04StudioAssetDraftJob / o_v04StudioDraftArtifact are reused. No new table or schema. ASSET_IMAGE_EDIT is dispatched by the existing single Draft worker. Source is conditioned through both VAE reference latent and grounded image encoding; image edit never silently degrades to T2I.

Jobs survive reload. Candidate cards show preparation/result/failure and Adopt / Continue / Reject. Adoption opens read-only Preview, then requires an explicit Confirm carrying previewHash. Only then is a GENERATED_CANDIDATE attachment registered as an Asset Bible reference, with its generated provenance retained. This does not mutate the canonical asset or Visual Spec, bind a production asset or replace production output. Candidate rejection is scoped and cannot revoke an already-confirmed reference. Acceptance retries replay the same promotion.

Unreviewed edits are excluded from existing Reference Pack job reads. Only an explicitly accepted, still-current edit can take the default card display slot; selected purpose still takes precedence. Currentness is projected using the same pure predicate as worker and adoption checks. Stale candidates retain images and historical SUCCEEDED records.

Explicit conversational '就用这张' opens Preview rather than silently applying; '不要这个版本' records rejection. Already-adopted candidates can still be selected for further editing. Candidate history remains separate from workspace Truth and survives session reload.

## Execution profiles and workflow

- KREA2_T2I_ASSET_V1: independent new-source T2I graph; never used as silent identity-edit fallback. Real disposable pirate-ship source benchmark passed. Automatic source-less Studio generation is not enabled by this ticket; an existing draft image is required for editing.
- KREA2_SOURCE_EDIT_V1: source + instruction.
- KREA2_REFERENCE_EDIT_V1: external image first, source subject second, matching edit LoRA training.
- KREA2_DERIVE_CHARACTER_REFERENCE_V1: source-conditioned portrait/back/view candidate.

Version: krea2-identity-edit-1.2-fit-v1.
Model files reused: krea2_turbo_fp8_scaled.safetensors; qwen3vl_4b_fp8_scaled.safetensors; qwen_image_vae.safetensors.
New LoRA: krea2_identity_edit_v1_2.safetensors.
8 steps, CFG 1, Euler / simple, seed frozen per request, 768 square, CLIP on CPU, tiled VAE decode. Krea2EditModelPatch gets source latent, source image, VAE and target latent before sampling. Krea2EditGroundedEncode gets the corresponding images. Reference boost 4, external boost 1, LoRA strength 1.

Only a confirmed terminal OOM permits one automatic retry at 512 square, with the original prompt ID and effective fallback parameters recorded. No retry for uncertain submission, lost acknowledgement or recovered RUNNING-without-prompt-ID; no silent T2I fallback. Source drift prevents settlement as a usable candidate, preserving old outputs. Failures display safe natural-language messages; technical codes remain backend diagnostics.

MVP external references are limited to one scoped image per edit, not silently truncated. Supported tested use is style/light/material/composition advice, not a guarantee of face replacement, exact pose control or pixel preservation. Multiple-reference and identity-replacement capabilities remain limited.

## Downloads / installs

Only new plugin: D:/comfy/ComfyUI/custom_nodes/comfyui-krea2edit
Upstream: https://github.com/lbouaraba/comfyui-krea2edit
Installed commit: 86f886dac23013d88996e3a2e99093ba44d322fb (1.2.5)
No additional Python dependencies installed.

Only new model support file: D:/comfy/ComfyUI/models/loras/krea2_identity_edit_v1_2.safetensors
Pinned upstream commit: 89e9e7a09ee2e5c9331e952063d79b1b8a703280
SHA-256: 6adf9a69cc9502d286db7b69964d37da7e9cfe4b05b4d004bc275f087d3fd3cf
Source: https://huggingface.co/conradlocke/krea2-identity-edit
About 1.83 GB. Existing UNet/encoder/VAE reused; no existing node, model or workflow removed or replaced. Comfy was restarted once from an empty queue with its previous lowvram/cuda-malloc/manager flags. Registered nodes verified through object_info, not inferred from directories.

Primary reference: https://raw.githubusercontent.com/Comfy-Org/docs/main/tutorials/image/krea/krea-2.mdx
A plain T2I or style-image embedding is not treated as identity editing; the edit LoRA and dual source-conditioning path are explicit.

## Real local executions

Evidence directory: v04-experiment/opt029a-evidence (../../opt029a-evidence from this document).
Full parameter graphs, prompt IDs and prompts: v04-experiment/opt029a-evidence/*-workflow.json and real-results.json.
Source for the main comparisons: D:/comfy/ComfyUI/output/Krea2_turbo_00008_.png, existing satisfied FULL_BODY_FRONT candidate. It was used as a disposable draft identity reference, never promoted to Truth. External style reference: Krea2_turbo_00013_.png. Neither was imported into the current project's authoritative reference set.

| Test | Time seconds | Result | Visual assessment |
| --- | ---: | --- | --- |
| Legacy MAIN source edit | 77.614 | SUCCEEDED | End-to-end source conditioning; remains stylized/cute |
| Good FRONT text edit | 56.437 | SUCCEEDED | PARTIAL: identity/costume broadly retained; exact face/proportions require human review |
| Good FRONT external reference | 83.945 | SUCCEEDED | PARTIAL: style/light transferred, costume/feet retained, unwanted roof-background transfer |
| FACE_HERO derivation | 54.926 | SUCCEEDED | Candidate available; close-up frontal framing works, likeness requires human review |
| FULL_BODY_BACK derivation | 54.914 | SUCCEEDED | Candidate available; rear framing, hair/sleepwear/barefeet broadly consistent; unseen face cannot be validated |
| V1 to V2 text edit | 62.728 | SUCCEEDED | Real prior output used as source, no return to original MAIN |
| Pirate ship disposable T2I source | 24.489 | SUCCEEDED | Benchmark fixture only |
| Pirate ship source edit | 64.168 | SUCCEEDED | PARTIAL: silhouette/masts broadly retained, aged/darker timber; not exact geometry control |
| Real product worker / temporary SQLite | 57.023 | SUCCEEDED | Real upload, submit, history, download, registered artifact and lineage; no Truth promotion |

9 real local executions, no OOM observed. These were not cherry-picked. No peak-VRAM measurement was taken; model file size is not claimed as VRAM usage. Reference composition leakage is a real limitation. None is automatically approved production quality.

The temporary-SQLite worker test used a mocked text intent resolver and the actual Comfy executor. Focused HTTP tests used mocked provider/Comfy with real temporary SQLite and actual routes. Full real logged-in Studio browser interaction was not verified: browser control initialization failed ('failed to write kernel assets'). An attempted database-password login script was rejected by automatic approval and was not created/run; no credentials were extracted. These boundaries must not be represented as a completed human Pilot.

## Engineering evidence

Backend commands:
- node --test tests/v04-asset-image-edit.test.cjs tests/v04-pilot.test.cjs
- node --test tests/*.test.cjs
- npx tsc --noEmit
- npm run build
- DS_OPT029A_REAL_WORKER=1 node --test --test-name-pattern='optional real local worker' tests/v04-asset-image-edit.test.cjs

Focused: 66 passed / 4 intentionally skipped (70 total).
Full: 358 passed / 4 intentionally skipped (362 total).
TypeScript: PASS. Build: PASS.
Optional real-worker test: 1/1 PASS.

Tests cover source dual conditioning, no edit-to-T2I downgrade, frozen lineage and hash, durable idempotent jobs, source-role resolution, V1 to V2, rejection, scope/ownership, BRAND/REAL_REQUIRED rejection, explicit hash-protected adoption and replay, stale projection/history, worker postflight drift, bounded OOM recovery, uncertain recovery without resubmission, actual HTTP natural-language and attachment pathways, zero Truth mutation.

Frontend commands:
- node --test tests/v04-studio.test.cjs tests/v04-main-preview-restore.test.cjs
- node --test tests/*.test.cjs
- npm run build-only
- npm run type-check
- npx vue-tsc --noEmit -p tsconfig.app.json --ignoreDeprecations 5.0 --composite false --incremental false

Focused 19/19; full 169/169; build-only PASS.
Standard type-check remains BLOCKED by pre-existing TS5103 Invalid value for --ignoreDeprecations. Diagnostic check also exposes existing errors outside this task (theme types, Window.$electron, ImportMeta.glob, old workspace props, etc.); no modified Pilot file error was reported. Do not call global frontend type-check PASS.

A prior full-test expectation that image-bearing Studio messages bypass Studio Turn was updated to assert the exact new Studio route and attachment forwarding. New tests exercise actual candidate polling generation guards, accepted-image display priority, compiled templates and explicit review surfaces, retaining Reference Pack and legacy MAIN restoration regressions.

## Changed application files

Backend:
- src/v04/assetImageEdit.ts
- src/v04/assetImageEditContract.ts
- src/v04/kreaImageEditProfile.ts
- src/v04/studioDraftImage.ts
- src/v04/studioTurn.ts
- src/v04/studioTurnSemantic.ts
- src/v04/router.ts
- tests/v04-asset-image-edit.test.cjs
- pilot/opt029a-comfy-spike.ts
- pilot/opt029a-real-matrix.ts
- pilot/OPT-029A.md

Frontend:
- src/views/pilot/ProjectAgentPanel.vue
- src/views/pilot/StudioWorkspace.vue
- src/views/pilot/StudioAssetDrawer.vue
- tests/v04-studio.test.cjs
- tests/v04-pilot.test.cjs

Generated local router/types overrides retained, not committed. No DB schema, production Attempt, 001E, Revision or Prompt IR modification. No control-repository changes.

## Human Pilot entry

Open http://127.0.0.1:50189/#/studio?projectId=1790941805789310&scriptId=4
Backend http://127.0.0.1:10589, same existing experimental disposable data directory v04-experiment/userdata/pilot/data. Comfy http://127.0.0.1:8188.

1. Select CHAR-001. Say '把这个男孩改得更写实一点，保留现在的脸、发型和睡衣。' Wait for the candidate image, not merely the Agent text reply.
2. Click Continue, say '这个方向对了，但眼睛再自然一点。' Confirm V2 uses V1; old versions remain in history.
3. Attach one style image, say '参考这张图的风格和光影，保留男孩的身份、年龄和服装。' Inspect both identity and unwanted reference leakage.
4. Say '基于当前人物生成同角色大头照。' Then '基于当前人物生成背面全身参考。' Compare visible identity features separately from view compliance.
5. Reload. Candidate history/images must recover. Switch project while running; late responses must not enter the new project's state.
6. Adopt only a visually acceptable candidate, inspect Preview and explicitly Confirm. Verify only the reference is registered; Visual Spec and production bindings remain unchanged. Reject an unaccepted candidate to verify the old reference is preserved.

Existing persisted CHAR-001 default source is the older Z-Image MAIN_PREVIEW until a newer successful candidate/reference role exists. The isolated benchmark's good Krea FRONT was not silently imported or made authoritative. Quality from that benchmark is not falsely claimed as the current card's existing source.

Services stay running. Human Pilot READY for trying the MVP; not ACCEPTED. No Stable userdata read/write and no protected historical database access. No PR, merge, force push or Stable branch change.

Stable hashes, checked before and after experimental push:
Backend 194340d6a37c6ef03a6d157f5848490f67c2e834
Frontend 986fb0ff32fd257498974c6c87cf4c47f360cb03
Final experimental commit hashes are supplied in the delivery message and local completion manifest.

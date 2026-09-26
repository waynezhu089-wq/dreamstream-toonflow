# REAL_AI_COMPOSITE single-shot prototype

This prototype is opt-in for an individual advertisement storyboard. It does not
automatically dispatch composite shots from batchGenerateImage. That entry returns
CAPABILITY_INPUT_UNSUPPORTED with instructions to use the two-stage UI.

## API

Authenticated POST endpoints under `/api/production/storyboard/composite`:

- `/start`: projectId, scriptId, storyboardId, primaryAssetId,
  backgroundCapabilityId, prompt, width, height, seed. Returns an attempt immediately.
- `/read`: projectId, scriptId, storyboardId, optional attemptId (otherwise latest).
- `/finish`: same scope, attemptId, screenQuad, confirmed: true.

screenQuad contains topLeft, topRight, bottomRight, bottomLeft, each `{x,y}` in
original background pixels. It must be an in-bounds clockwise convex polygon.
The user must confirm its placement. A new background creates a new attempt and
requires a new confirmation. No screen coordinates are stored in productionSpec.

`o_compositeAttempt` is additive and holds scope, inputs, source image/path/hash,
background path/hash/Comfy prompt ID, quad, final path, status and errors. Attempts
are independently addressable for future retry/batch/template tooling. The latest
attempt and unchanged productionSpec are required before publishing its output.

Only COMPLETED writes the final PNG to storyboard.filePath. Background completion
enters AWAITING_QUAD and leaves the storyboard unfinished. Failed providers,
invalidated sources, changed background files and obsolete attempts never fall
back to text-to-image/reference generation.

## Local background adapter

Capability: `comfy.z-image-turbo.txt2img.v1`. `COMFY_API_URL` defaults to
`http://127.0.0.1:8188`. The installed, validated Z-Image Turbo graph is private to
the adapter. Dynamic inputs are prompt, width, height and seed. Required files:
qwen_3_4b_fp8_mixed.safetensors, ae.safetensors and
z_image_turbo_int8_convrot.safetensors. The background prompt always adds a blank
screen requirement. No real asset pixels are submitted to Comfy.

The deterministic stage uses Sharp for decoding/PNG output and an inverse
homography with bilinear sampling and a polygon mask. It does not draw text,
modify UI elements or synthesize screen content. It rechecks the existing Gate,
current unit Asset Plan binding, current image and upload receipt, and compares
the real file hash with the attempt's source hash.

Reserved: auto screen detection, rounded/device occlusion masks, templates, batch
UI, reference groups, general capability registration, prompt Skill management.
On process interruption an unfinished attempt is not complete; create a fresh
attempt explicitly (no automatic background replay or paid provider fallback).

## Verification

`npm run test:composite` covers the real database wrapper, HTTP scope/Gate,
two-stage state transitions, source invalidation, pixel provenance, quad errors,
capability/provider failures and retry isolation using temporary SQLite and a
stubbed Comfy transport. The actual local Comfy/real-asset run is recorded
separately in the control repository CURRENT.md; fixtures are not live evidence.

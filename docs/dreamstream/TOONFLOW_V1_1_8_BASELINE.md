# Dream Stream Toonflow v1.1.8 Baseline

This branch is the controlled starting point for turning Toonflow into Dream Stream's first video-production workshop.

## Upstream baseline

- Upstream repository: `HBAI-Ltd/Toonflow-app`
- Upstream release/tag: `v1.1.8`
- Source commit: `cd3e7c4e83963bea255be2e621eb78d2cd1c2188`
- Dream Stream baseline branch: `dreamstream/baseline-v1.1.8`
- Dream Stream working branch: `dreamstream/general-video-v0.1`

## First product direction

Keep the existing short-drama routes working while preparing a minimal general-video path. The first production profile will be `advertisement`, with a real ~30-second advertisement/brand short video as the first production acceptance target.

## First engineering gate

Before changing business logic:

1. Map the source modules that implement project creation/routing, ScriptAgent, ProductionAgent, Skills, Vendor adapters, assets, storyboards, video generation, workbench integration, storage/database, and sockets.
2. Determine the exact reproducible install/build/test commands for this v1.1.8 source baseline.
3. Run only deterministic/local engineering checks. Do not call paid model/video/image/TTS APIs.
4. Record blockers and any source/runtime mismatch with the user's installed v1.1.8 package.
5. Do not change production behavior in this gate.

This document is a construction marker only; it does not authorize deployment, publishing, paid generation, or merging.

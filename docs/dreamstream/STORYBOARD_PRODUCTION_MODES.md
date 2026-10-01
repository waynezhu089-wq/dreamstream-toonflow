# DS-PRODMODE-001 — Storyboard Image Production

Advertisement dispatch uses an explicit `productionMode`. Non-advertisement
routes retain their existing `shouldGenerateImage` behavior. Existing advertisement
rows are not guessed or backfilled: a missing mode fails with
`PRODUCTION_MODE_REQUIRED` when production is requested.

## Persistence and API

Seven flat API fields are persisted in nullable `o_storyboard.productionSpec`, a
JSON envelope with `schemaVersion: 1`:

| Field | Type / meaning |
| --- | --- |
| productionMode | REAL_ASSET_DIRECT / AI_TEXT_TO_IMAGE / AI_REFERENCE_GENERATE / REAL_AI_COMPOSITE |
| primaryAssetId | nullable positive integer; explicitly selected real primary asset |
| referenceAssetIds | positive integer array; individual reference assets |
| referenceAssetGroupIds | opaque nonempty string ID array; future groups |
| promptSkillId | nullable string |
| promptSkillVersion | nullable string |
| capabilityId | nullable stable capability ID, never a Comfy node ID |

New advertisements require an explicit mode on add/batch add/replace. These
operations reuse existing payload fields (prompt, duration, videoDesc, track,
associateAssetsIds, shouldGenerateImage, etc.). Edit merges only supplied production
fields; omitted fields remain, null/empty arrays explicitly clear values. Edits to
prompt or production specification invalidate the previous image output. Whole
replace validates every item before deleting old rows, runs transactionally, and
retains all seven fields. Existing video records still prevent whole replacement.

Integrated routes under `/api/production/`:

- `storyboard/addStoryboard`
- `storyboard/batchAddStoryboardInfo` (`data[]`)
- `storyboard/replaceStoryboard` (`data[]`, existing limit 50)
- `storyboard/editStoryboardInfo` (`id`; projectId/scriptId, if supplied, must match)
- `storyboard/getStoryboardData` and `getStoryboardData`
- `getFlowData` (workspace storyboard projection)
- `storyboard/batchGenerateImage` (`storyboardIds[]`, projectId, scriptId)

All write references must belong to the current project + unit's ready, valid Asset
Plan bindings. Primary real assets also require current upload provenance, even
when the Plan item's source policy permits AI. `associateAssetsIds` remains a list
of real asset IDs; its ordering never chooses a primary or silently supplies image
references. Read routes scope by the actual script's owning project. Agent tool
schemas and the frontend Socket→HTTP transport retain the new fields.

The nullable column is additive and idempotently migrated at startup; the fresh
initDB table builder also includes it. Old data is not rewritten. Group IDs are
stored without pretending to resolve groups: a future group registry can resolve
these IDs to scoped members/views without changing the storyboard API. Prompt
Skill identity/version are metadata for future recommendation, replacement and
prompt rewriting; this task adds no Skill registry or editor.

## Dispatch boundaries

| Mode | Implemented behavior |
| --- | --- |
| REAL_ASSET_DIRECT | Revalidate Plan, scope, completed current image and upload receipt; use its exact filePath as output; mark completed; no model or provider/task call |
| AI_TEXT_TO_IMAGE | Resolve/check image Model Preset at point of use; call existing u.Ai.Image.run/save and task-record lifecycle, including provider failure |
| AI_REFERENCE_GENERATE | Explicit CAPABILITY_INPUT_UNSUPPORTED; no provider call or fallback |
| REAL_AI_COMPOSITE | Explicit CAPABILITY_NOT_IMPLEMENTED, needs Composite Capability; no provider call or fallback |

Direct accepts no extra references, and text-to-image accepts no primary/reference
inputs. Text mode never converts associated real UI/Logo/labels to image inputs.
Pixel-authentic UI/Logo/packaging belongs in direct or composite mode; reference
generation cannot be used to redraw it and claim authenticity.

Capability may be null (current compatibility path), `toonflow.image.v1` for the
shared text-to-image path, or `toonflow.real-asset-direct.v1` for direct. Other IDs
are preserved but explicitly unsupported on dispatch. Comfy is **not** connected;
even `comfy.z-image-turbo.txt2img.v1` does not silently use the old image model.

Batch generation preserves the existing asynchronous polling contract: HTTP 200
acknowledges accepted work with `state=生成中`, not successful image production.
Read `storyboard/pollingImage` for per-shot final state and reason (including error
code). Failed items have no output path. `compulsory` cannot override a mode.
Mixed batches produce valid items and record unsupported/failing items separately;
single/multiple ID retries affect only selected shots. The writer service is also
array-based to support future bulk edits; no batch UI is included.

## Validation

`npm run test:storyboard-production`: real runtime DB wrapper, temporary SQLite,
real HTTP routes, real shared Ai.Image and task-record implementation. Only vendor
execution, external storage and bootstrap embeddings use test doubles. Includes
the generic five-screen/ten-shot fixture: seven direct outputs and three explicit
composite failures. No user database, paid model, real image generation or Comfy
service is accessed. These tests are not full V0.2 Gate Audit acceptance.

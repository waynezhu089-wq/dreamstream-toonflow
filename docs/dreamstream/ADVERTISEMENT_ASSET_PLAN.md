# Advertisement Asset Plan (DS-BE-003)

Asset Plans belong to one advertisement project and production unit (`projectId + scriptId`). There is no first-unit fallback or project-specific asset template. This API is registered behind the existing application authentication middleware and is available during preparation, before the existing Production Gate passes.

## HTTP contract

All endpoints use POST with JSON under `/api/project/advertisement/assetPlan`:

- `/read`: `{ projectId, scriptId }`.
- `/save`: `{ projectId, scriptId, items }`. Atomically replaces the entire plan for that unit; `items: []` clears it. Omitted keys are deleted. Include `assetId: null` to leave/unset a binding.
- `/bind`: `{ projectId, scriptId, assetKey, assetId }`. Binds an existing plan item.
- `/unbind`: `{ projectId, scriptId, assetKey }`. Clears an existing item binding; repeated unbind is safe.

IDs must be positive safe integers. Each item contains:

```json
{
  "assetKey": "brand-mark",
  "name": "Brand mark",
  "category": "brand",
  "required": true,
  "sourcePolicy": "REAL_REQUIRED",
  "assetId": null
}
```

The caller supplies a stable key and retains it on edits. Keys are trimmed, case-sensitive and unique within the unit (max 128 characters). Name/category are nonempty, project-defined strings. Required is a boolean; sourcePolicy is exactly `REAL_REQUIRED` or `AI_ALLOWED`. Up to 200 items per replacement. Duplicate keys, unknown request fields and malformed values are rejected.

Success uses the existing `{ code: 200, message, data: { projectId, scriptId, items } }` envelope. Returned items also contain `bindingValid` and `bindingIssue` (`UNBOUND`, a validation reason, or null). These read-only diagnostics are not input fields; save the six editable fields only.

Invalid context/request/scope: HTTP 400. Missing item: 404. Missing real-source evidence: 409. Storage failure: 500. Error `data.reason` is machine-readable. Replacement and binding are transactional; failures preserve the previous plan. Concurrent replacements serialize in SQLite; the last completed replacement wins (no version locking).

## Scope and source evidence

Bindings require an asset in the current project with an existing `o_scriptAssets` association to the current unit. An explicit asset `scriptId` must also match. The API never creates associations or borrows another unit's assets.

`REAL_REQUIRED` requires a server-recorded upload receipt for the asset's **current** image ID and file path. Actual uploads through `assets/uploadClip` or the base64 upload branch of `assets/saveAssets` write that receipt in the same database transaction as the asset/image update, after storage succeeds. Selecting an existing image does not create upload evidence. An AI-model image cannot qualify. A prior upload cannot bless a later generated/replaced image.

No origin inference from names, file paths or client assertions. Historical assets without reliable receipts must be re-uploaded before REAL_REQUIRED binding. Upload provenance proves the server received an uploaded file; it does not certify the semantic authenticity of its contents.

`AI_ALLOWED` accepts current-unit registered assets, including AI-created assets and uploads, without requiring an upload receipt. It does not imply that generation is finished. Reads revalidate current binding scope/source, exposing later deletion, relinking or image replacement without mutating the plan.

## Storage and boundaries

Startup additively initializes `o_advertisementAssetPlan` (primary key: projectId, scriptId, assetKey) and `o_assetUploadSource` (primary key: assetId, imageId). Existing tables, plans and Gate records are preserved; initialization is idempotent. No inferred provenance backfill.

This task does **not** connect Asset Plan to Advertisement Gate. Existing Gate confirmation/readiness semantics remain unchanged. No frontend changes, Brief versions, asset version locks, AI planning or paid-model calls. A future task will make Gate check required items against the current unit's plan.

## Regression

`npm run test:advertisement-asset-plan` uses actual route/service/schema code, Express HTTP and temporary file SQLite. External storage is a test double; no real business database or models are used. Existing `test:production-workspace` and `test:advertisement-gate` remain compatibility checks.

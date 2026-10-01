# Production Profile Registry and Stage Orchestrator V1

DS-V03-CORE-001A implements the V0.3 control plane alongside the V0.2 production kernel. The canonical contract is `dream-stream/DS-V03-CORE-001A_PROFILE_STAGE_ORCHESTRATOR_FREEZE_2026-09-25.md` (HF1). Stage actions record control-plane progress; they do not start generation, replace the current production route, or enforce a new hard gate on existing generation endpoints.

## Data and bootstrap

Startup incrementally creates `o_productionProfile`, `o_productionProfileVersion`, `o_projectProfileBinding`, `o_stageRun`, and immutable `o_stageEvent`. Existing V0.2 tables are unchanged. The built-in `advertisement @ v1 ACTIVE` contains the frozen 12-stage sequence; `asset-preparation` alone has `exitGateKey: advertisement.asset-ready`. Bootstrap is idempotent and never overwrites an existing v1 definition or mass-binds old projects. A partial unique SQLite index prevents two ACTIVE versions of the same family.

Family keys and Stage keys are stable business identifiers. The exact Profile Version is externally `v1`, `v2`, etc. and stored as an integer. Definition `schemaVersion: 1` contains `initialStageKey`, `stages`, and ADVANCE `transitions`. Each Stage defines `stageKey`, `displayName`, `description`, `required`, `allowSkip`, `uiOrder`, `entryGateKey`, and `exitGateKey`. The validator rejects extra fields, duplicate keys/orders, invalid edges, cycles, unreachable stages, and `required && allowSkip`. Gate keys are semantic identifiers, not routes or service names.

## Registry and binding

Authenticated POST endpoints under `/api/productionProfiles`: `list`, `get`, `family/create`, `version/create`, `version/edit`, `version/activate`, `version/deprecate`, `resolve`, `bind`, `adopt-legacy`. Version editing requires DRAFT. Activation demotes the previous ACTIVE and activates the target in one transaction. Historical DEPRECATED exact versions remain readable. Normal MANUAL binding only accepts ACTIVE, and a project with Stage Run records cannot switch Profile or version (`PROFILE_BINDING_LOCKED`). The `RECIPE` source value is reserved; 001A does not implement Recipe binding.

An unbound legacy Advertisement project resolves read-only to exact `advertisement @ v1 / LEGACY_ADAPTER`. `adopt-legacy` persists that already-resolved exact v1, including after v2 activation deprecates v1. It never substitutes the latest version. Unbound non-Advertisement projects resolve as unmanaged; no bulk migration occurs.

## Orchestrator and Gate

Authenticated POST endpoints under `/api/stageOrchestrator`: `read`, `start`, `complete`, `skip`, `events`. Every request checks project existence, script ownership, and exact Profile resolution. The runtime key is `projectId + scriptId`; the binding key is project only. Reads return all Stages plus `readyStages`, `blockedStages`, `inProgressStages`, `completedStages`, and `skippedStages`. Missing Stage rows derive as PENDING. READY/BLOCKED are derived from incoming predecessor completion and entry Gate; ACTIVE/DONE reflect persistent state.

`start` changes READY PENDING to IN_PROGRESS. `complete` changes IN_PROGRESS to COMPLETED only if the exit Gate passes. An optional PENDING Stage may be skipped only when READY; an optional IN_PROGRESS Stage requires HUMAN actor and a nonempty reason. Every successful transition conditionally changes `o_stageRun` and inserts one `o_stageEvent` in the same transaction. Competing duplicate requests cannot both record success. There is no reopen, rollback, repeat, automatic downstream invalidation, or Supervisor decision in 001A.

The Gate Adapter Registry fails closed: an unknown key returns `GATE_ADAPTER_NOT_REGISTERED`; an exception or untrusted response returns `STAGE_GATE_UNAVAILABLE`. The `advertisement.asset-ready` adapter calls the existing V0.2 `readState(projectId, scriptId)` and passes only when its `ready` result is true. It exposes the existing result and a readable blocker; it does not implement Asset Plan readiness a second time. Gate snapshots are checked before the Stage mutation transaction; 001A does not claim a serializable transaction across the old Gate and new Stage tables.

## Human inspection

Settings → Production Profiles shows exact versions, Stage graph, Gate labels, and Advanced Draft management. The generic Stage Orchestrator Inspector is available in Advertisement Asset Preparation → Advanced even while the existing Production route Gate blocks entry. It receives the selected project and script from the page, never asks the user for IDs, and supports read, Adopt, start, complete, and skip. The Inspector explicitly says that it does not replace or gate the existing production flow.

For acceptance, inspect `advertisement @ v1 ACTIVE` and its 12 Stages, open an existing unbound Advertisement project, confirm LEGACY_ADAPTER without a binding write, then Adopt. Advance `brief`, `asset-planning`, and `asset-preparation`; while Asset Gate is blocked, completion must explain the real blocker and the existing Production route must still reject entry. After the existing Asset Gate is ready, complete `asset-preparation` and confirm `director-planning` becomes READY. Activate a v2 Draft and confirm the Adopted v1 project remains on v1. No paid model or Comfy call is needed.

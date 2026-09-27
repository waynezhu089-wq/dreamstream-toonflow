# B3-A Read-only Revision Preview

Status: READY_FOR_HUMAN_ACCEPTANCE after implementation verification. This endpoint only plans a semantic revision; it never confirms or applies one.

`POST /api/stageOrchestrator/revision/preview` accepts:

```json
{
  "schemaVersion": 1,
  "revisionId": "1e1f8365-e2b8-4e41-a4c1-734ab130a170",
  "projectId": 1,
  "scriptId": 10,
  "revisionKey": "storyboard.semantic.v2",
  "changeSet": {
    "operations": [
      { "type": "EDIT", "storyboardId": 7, "patch": { "prompt": "New semantic intent" } },
      { "type": "ADD", "clientRef": "insertA", "storyboard": {
        "track": "Main", "duration": 3, "prompt": "New shot", "videoDesc": null,
        "productionMode": "AI_TEXT_TO_IMAGE", "primaryAssetId": null,
        "referenceAssetIds": [], "referenceAssetGroupIds": [], "linkedAssetIds": []
      } },
      { "type": "RETIRE", "storyboardId": 8 },
      { "type": "REORDER", "order": [
        { "clientRef": "insertA" }, { "storyboardId": 7 }
      ] }
    ]
  }
}
```

The complete `REORDER.order` lists every active shot after EDIT/ADD/RETIRE. ADD may specify a nonnegative `index`; otherwise it appends after the highest index in the proposed collection at that point, including earlier ADDs. A specified index must be distinct from all retained and earlier added indices; a genuine collision is rejected even when REORDER is present. Complete REORDER assigns the existing distinct index slots to its declared order. Without REORDER, unrelated retained shots keep their indices. EDIT omits unchanged fields; index changes use REORDER. ADD's `clientRef` exists only in this proposed snapshot. No database ID is reserved. Asset IDs must belong to this production unit; a new Asset Group reference is rejected until group ownership can be verified.

The normal API envelope returns `data` containing `schemaVersion`, `revisionId`, `revisionKey`, `previewHash`, `sourceTargetHash`, `proposedSemanticHash`, `profile`, `recipe`, `ownerStageKey`, `protectedChange`, `descendantStageKeys`, `stageTransitions`, `affectedActiveAttempts`, `outputImpact`, `warnings`, and `proposedSemantic`. `sourceTargetHash` is the accepted persisted B1 Semantic V2 target hash. `proposedSemanticHash` uses operation-local ADD references and is **not** a persisted Supervisor target hash.

Each `outputImpact` item reports the retained file and current/active Attempt pointers, before/after freshness (`NONE`, `LEGACY`, `CURRENT`, `STALE`, or `UNKNOWN`), B2 current/proposed Source hashes where evaluable, and whether the canonical Source changes. A `CURRENT` source result does not itself authorize production: planned Stage transitions and Gate admission remain separate. `UNKNOWN` and `LEGACY` are not reuse guarantees. No cost or generation-time estimate is returned.

The server resolves the exact Profile, Review and optional Recipe, captures all required rows in one SQLite read transaction, then calculates the plan and hash in memory. It performs no database write, lazy initialization, model/provider call, queue work or media-byte access. Input and snapshot sizes are bounded; invalid scope, unsupported exact Profile, conflicting operations, unowned assets and inconsistent Attempt ownership fail explicitly.

B3-B Confirm, persistence, Stage transitions, mutation guards and any frontend control are outside this release.

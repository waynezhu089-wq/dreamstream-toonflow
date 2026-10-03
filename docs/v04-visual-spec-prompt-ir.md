# V0.4 Visual Spec and Prompt IR (OPT-027A)

Status: **EXPERIMENTAL / HUMAN PILOT PENDING**. This layer does not execute an image model.

`o_v04Asset` remains the project identity truth. `o_v04AssetVisualSpec` stores versioned, human-confirmed appearance truth by `projectId + canonicalKey`; it is independent of a production-unit binding. Proposal and Preview perform no writes. Apply verifies the current asset revision and a preview hash in one transaction, supersedes the prior confirmed spec, and projects `identityAnchors`, `mustPreserve`, and `forbiddenChanges` back to `o_v04Asset`. If an ordinary Asset Bible edit later increments the identity revision, the prior spec reads as `STALE` and its Prompt Build is marked stale. The Asset Bible fields are authoritative while that spec is stale. Accepted visual references and production bindings are retained.

Authenticated V0.4 routes:

- `POST /v04/visual-spec/propose` — `{ projectId, scriptId, canonicalKeys: string[] }`, at most six. Each AI-allowed asset uses one configured text-model call and a lightweight semantic JSON response. Brand/UI reference-only candidates require confirmed Asset Bible references and do not call a model.
- `POST /v04/visual-spec/preview` — `{ projectId, scriptId, canonicalKey, sourceAssetRevision, spec }`. Returns `previewHash`, current/proposed spec, next revision, and incomplete field paths. No write.
- `POST /v04/visual-spec/apply` — Preview body plus `previewHash`. Rejects stale identity, changed reference evidence, changed Preview, and incomplete specs. This is the sole Visual Spec truth write.
- `POST /v04/visual-spec/prompt/rebuild` — Recompile the current confirmed spec with the current compiler version. No provider or media call.
- `POST /v04/assets/library-binding/set` — Explicit nullable metadata for future library reuse. It requires pinned library/profile versions when corresponding IDs are supplied; it creates no global identity and never changes the project canonical key.

`o_v04AssetPromptBuild` stores derived Prompt IR and a generic text rendering. It records exact Visual Spec revision, compiler version, generation intent and target profile. It is never project truth. A new spec revision marks older READY builds STALE. A compiler-version mismatch also reads as stale. Brand/UI and all `REAL_REQUIRED` assets remain reference-only and produce no AI-generation package.

Generation intent comes from the existing Review Plan's reference-only boundary plus the asset kind: human/creature/vehicle turnaround, environment establishing, material state board, celestial reference, or object reference. Turnaround views share the same identity block and constraints. Environments default to `EMPTY_CANONICAL_REFERENCE`. Material boards share one palette and material logic across Mist, Particle, Silhouette, and Solid. The compiler includes only the current asset's confirmed spec and identifiers for owner/variant/visual-system relationships; it never recursively expands another asset's prompt.

Embedded elements remain inside a Visual Spec. A HIGH promotion recommendation is visible in the UI but does not create another asset. `o_v04AssetLibraryBinding` is an extension point only: no import, search, publishing, automatic global ID, or auto-upgrade workflow is implemented. OPT-028 will own image execution and human acceptance of generated references.

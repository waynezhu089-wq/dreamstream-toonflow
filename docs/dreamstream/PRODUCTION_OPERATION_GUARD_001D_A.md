# D-A Production Operation Guard

Profile Definition V1 remains advisory: installing D-A does not rebind or upgrade an existing project. Definition V2 opts in with `runtimeControl: "ENFORCED"` and a unique `operationKeys` array on every Stage. The exact version and its hash remain owned by the Profile Registry.

The server maps `batchGenerateImage` to `storyboard.image.generate`, composite start/finish to `storyboard.image.composite`, and `updateStoryboardUrl` to `storyboard.image.attach`. Client-supplied operation or Stage keys are ignored. The existing Production middleware first establishes each affected `projectId + scriptId` and applies the existing Advertisement Asset Gate, then calls the operation guard before the route handler.

For V2, the guard uses one SQLite read transaction for the exact Profile, Stage Run, transitive predecessors, and Gate closure. The operation Stage must already be `IN_PROGRESS`; predecessors must be completed or legitimately skipped. It rechecks ancestor entry/exit Gates and the current Stage entry Gate, but not that Stage's exit Gate. Advertisement Asset and Supervisor Gate adapters use the same transaction. A stale Supervisor PASS therefore blocks the next real image action even if Stage Run rows have not changed. Admission is read-only and never starts, completes, or reopens a Stage.

Domain Gate codes pass through the existing Production Gate HTTP response under `data.code`. D-A only guarantees request-time admission. Long-running attempt freshness and controlled Stage reopen/invalidation belong to D-B; Recipe runtime resolution and generic Capability execution belong to D-C/D.

Human acceptance should create and inspect a fresh V2 Advertisement Draft, place `supervisor.storyboard-approved` on the `supervisor-review` exit Gate, and declare all three image operation keys on `image-production`. Activate and bind it only for a disposable project. Existing V1 projects remain on their exact definitions.

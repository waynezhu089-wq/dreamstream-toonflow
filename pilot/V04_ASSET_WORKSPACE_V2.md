# V0.4 Asset Bible workspace v2 (experimental)

This pilot keeps `o_v04Asset` as confirmed project identity and the existing Advertisement Asset Plan as the current production unit's binding and Gate authority. AI extraction only returns a proposal. `/v04/assets/preview` does not write. `/v04/assets/apply` validates the same preview hash and Creative version, then atomically creates identities, candidate relationships, the confirmed coverage audit, and review plans.

Extraction checks five logical passes: entities, environments, visual systems, continuity relationships, and Treatment coverage. Existing canonical identities such as a confirmed logo must be referenced or proposed for merge; they are not recreated. `assetKind` and `importance` extend the existing category without replacing it. Relations may point to existing project keys or other candidates in the same confirmed batch. Coverage records stay scoped to `projectId + scriptId`; Creative changes mark the accepted audit stale.

Review plans describe a 512-pixel maximum low-resolution output and, where applicable, front/side/back turnaround views. Core characters, creatures, vehicles and props receive turnaround plans by default. Supporting assets can be manually added to the turnaround plan. Environments receive an establishing preview; material/FX receives a board. Real-required assets, logos and UI use references only, with `aiRedrawAllowed: false`.

The additive experimental migration also creates reference-only or review plans for identities that were confirmed before this upgrade. It leaves their existing media and production bindings untouched.

`PLANNED` means work has been planned, **not generated or queued**. This pilot has no local image executor connected to these plans, so no preview or turnaround image is fabricated, no image model is called by planning, and no plan is production-ready output. AI extraction itself still calls the configured text model only after the user approves that call. The `previewSpec` and `turnaroundSpec` fields are the narrow future local-capability handoff. A later task must separately implement execution, retries and provenance before any status can become `READY`.

The Assets page groups confirmed identities, shows their relationships and review-plan state, and displays confirmed coverage plus unresolved and stale warnings before Storyboard. Coverage warnings do not alter the existing Advertisement Gate or Stage authority.

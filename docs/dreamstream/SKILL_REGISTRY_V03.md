# Dream Stream V0.3 Skill Control Plane

The V0.3 Skill Registry runs beside the existing Markdown file Skill runtime. `skills/**/*.md`, `skillsTools.ts`, `o_skillList`, and `o_skillAttribution` retain their existing behavior. Only advertisement Storyboard `IMAGE_PROMPT` compilation uses this new control plane in this phase.

## Stored contract

`o_skillRegistry` stores a family (`skillId`, display name, one of the twelve frozen `skillType` values, description, tags, timestamps). A family has no lifecycle status. `o_skillVersion` stores an integer version, `DRAFT`/`ACTIVE`/`DEPRECATED`, template, structured content, origin, definition hash, and timestamps. The API, UI, and Storyboard always use `v1`, `v2`, etc. Active content is immutable. Activating a new version deprecates the former active version, while exact historical references remain loadable.

`o_skillBinding` has one row per `(scopeType, scopeKey, skillType)`, with an exact `skillId + skillVersion`, an `overrideText`, or both. An override-only row inherits the lower-scope exact version without copying it. Keys use the canonical `system`, `profile:<key>`, `recipe:<key>`, `project:<id>`, `project:<id>:script:<id>:stage:<key>`, and `project:<id>:script:<id>:storyboard:<id>` formats. The resolver chooses the first exact version in `SHOT > STAGE > PROJECT > RECIPE > PROFILE > SYSTEM` order, but accumulates nonempty overrides in the opposite order. Its trace explains every considered scope. Profile and Recipe bindings are storage and resolution contracts only; their registries belong to later work.

The loader requires an exact ID and `vN`, validates the stored definition hash, and rejects Draft versions at runtime. It never loads the entire library or silently selects latest. Generic Skills use purpose, inputs, rules, output requirements, prohibitions, applicable scenes, and tags. `IMAGE_PROMPT` adds subject, composition, camera/lens, lighting, color, material, spatial relationship, style, detail density, background, motion, and negative constraints.

`o_skillCompile` stores the scoped Storyboard ID, exact Skill and definition hash, resolution trace, override chain, input context, output prompt, text-model reference, creation time, and optional application time. This table is a provenance record, not a new Storyboard state machine.

## IMAGE_PROMPT production boundary

`POST /api/skills/compile` requires `projectId`, `scriptId`, and `storyboardId` for an advertisement Storyboard with a ready Asset Gate. The compiler reads the current Storyboard, valid current-unit Asset Plan bindings, and stable Capability input-port contract. It never reads Comfy node IDs. It loads only the resolved `IMAGE_PROMPT` version and an optional, explicitly named exact `CONTINUITY` version. At Compile point of use, it resolves the existing `productionAgent:storyboardGenAgent` text-model route and asks that model to rewrite a complete prompt. Compile persists preview provenance without changing the Storyboard. It rejects mechanical old-prompt-plus-override output and rejects modes that would repaint bound real UI/Logo assets.

`POST /api/skills/compile/apply` requires the same scope plus `compileId`. It rejects stale Storyboard, Asset Plan, Skill, or override context; then reuses the existing Storyboard edit/invalidation path to write prompt, `promptSkillId`, and `promptSkillVersion`. The only UI Apply action follows an explicit human checkbox. A previous image is invalidated by the existing Storyboard edit rule, not by a new Skill-specific rule.

All endpoints are POST under `/api/skills`: `list`, `get`, `family/create`, `version/create`, `version/edit`, `version/activate`, `version/deprecate`, `version/preview`, `binding/save`, `binding/remove`, `binding/list`, `resolve`, `recommend`, `builder/copy`, `builder/project-derived`, `builder/reverse-compatibility`, `compile`, `compile/read`, and `compile/apply`. Stable `SKILL_*` error codes are returned in the existing API error envelope.

Manual creates a family and Draft V1. Copy creates a distinct family and Draft V1. Project Derived reads only one explicitly selected Storyboard Prompt, Director output snapshot, or Production text result; its origin record retains the source snapshot/hash while the public Draft strips project-specific identifiers and needs human editing before activation. Recommendation is deterministic and never binds automatically. Reverse Prompt is a source/provenance contract only: the present Bridge cannot execute image-to-text, so the UI reports incompatibility without fabricating a Draft.

## Human acceptance

In Skill Library, create `image-prompt.tech-product-cinematic` as an `IMAGE_PROMPT` Draft V1, fill its structured fields, preview the loader instruction, and activate it. Bind V1 to the current test project. In an advertisement Storyboard shot, confirm the project resolution trace, save a shot override-only binding, and inspect the inherited exact V1 and override chain. With a configured text model, Compile and compare the current and complete new prompt; confirm the original Storyboard remains untouched until the human checks and clicks Apply. Then confirm the Storyboard exact V1 fields and provenance. Create, edit, and activate Draft V2; confirm the project remains on historical V1 until a human explicitly upgrades its binding to V2. The Reverse Prompt entry should report an unavailable compatible capability.

The acceptance flow intentionally does not call image/video models or implement Recipe/Profile registries, Agent migration, or image-to-text execution.

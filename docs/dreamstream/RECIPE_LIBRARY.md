# DS-V03-CORE-001B Recipe Library

Recipe is an exact, reusable production blueprint. It recommends one exact Production Profile, zero or more exact Skill and Capability versions, an Asset Plan template, and human guidance. It does not execute or apply those recommendations to a project. The V0.2 Production Kernel and Advertisement Gate remain the production authorities.

## Definition V1

```json
{
  "schemaVersion": 1,
  "profileRef": { "profileKey": "advertisement", "profileVersion": "v2" },
  "skillRefs": [{ "skillType": "IMAGE_PROMPT", "skillId": "image-prompt.example", "skillVersion": "v1" }],
  "capabilityRefs": [{ "roleKey": "storyboard-image.text-to-image", "stageKey": "image-production", "capabilityId": "comfy.example.txt2img.v1" }],
  "assetPlanTemplate": [{ "assetKey": "brand-logo", "name": "Brand Logo", "category": "brand", "required": true, "sourcePolicy": "REAL_REQUIRED" }],
  "notes": ["Review this blueprint before production."]
}
```

Every reference is exact. Unknown fields, duplicate Skill Types, Capability roles, and Asset Keys are rejected. Project asset IDs, paths, upload provenance, Comfy node internals, and Model Presets are outside V1. At least one Skill, Capability, or Asset Plan recommendation is required to activate. The normalized definition is SHA-256 hashed and the hash is pinned in project bindings.

`o_recipe`, `o_recipeVersion`, and `o_projectRecipeBinding` are additive SQLite tables. DRAFT is editable; ACTIVE is immutable; activation deprecates the previous ACTIVE in one transaction. DEPRECATED remains readable. Dependency health is derived on reads. Activation and new project binding require the Profile and Skills to be ACTIVE and Capabilities VERIFIED. A historical project binding still resolves its exact deprecated Recipe without upgrading.

## HTTP API

All endpoints are POST under `/api/recipes` and use the usual response wrapper. The API accepts exact `vN` labels and never accepts `latest`.

| Path | Input | Effect |
|---|---|---|
| `/list` | `{}` | Families, exact versions, derived health |
| `/get` | `{recipeKey, version?}` | Exact or all versions |
| `/family/create` | `{recipeKey, displayName, description, tags}` | Create family |
| `/version/create` | `{recipeKey, sourceVersion? , definition?}` | Create Draft; exact source is optional |
| `/version/edit` | `{recipeKey, version, definition}` | Replace Draft definition |
| `/version/activate` | `{recipeKey, version}` | Validate dependencies; activate exact Draft |
| `/version/deprecate` | `{recipeKey, version}` | Deprecate exact ACTIVE |
| `/project/resolve` | `{projectId}` | Read exact project binding and Profile |
| `/project/preview-bind` | `{projectId, recipeKey, version}` | Read-only compatibility and recommendation preview |
| `/project/bind` | `{projectId, recipeKey, version, confirmProfileAlignment?}` | Bind exact Recipe |
| `/project/unbind` | `{projectId}` | Remove Recipe before Stage Run |

The project must be `general_video`. A persisted mismatched Profile blocks Recipe binding. When no Profile is persisted, preview reports `CAN_ALIGN_PROFILE`; bind then requires `confirmProfileAlignment: true` and atomically writes Profile Binding with source `RECIPE` plus Recipe Binding. Failed Recipe write rolls back Profile alignment. Removing Recipe leaves Profile in place. Any Stage Run locks Recipe replacement/removal. Direct Profile rebind to a different exact version is rejected while Recipe is bound.

Recipe bind does not write Project/Stage/Shot Skills, Storyboard production specs, Asset Plan rows, Model Presets, Stage state, or invoke AI/Comfy. The only allowed additional mutation is explicitly confirmed Profile alignment.

## Skill context

The optional Skill Resolver context uses both `recipeKey` and `recipeVersion` and verifies them against the project's persisted Recipe Binding. The exact Recipe Version's `skillRefs` fill the RECIPE priority slot: SYSTEM < PROFILE < RECIPE < PROJECT < STAGE < SHOT. Existing unversioned RECIPE binding rows are ignored. Public direct RECIPE binding save/remove is rejected. Existing production calls without Recipe context continue as before; automatic runtime context injection belongs to 001D.

## Human acceptance

Use a disposable Recipe and fresh `general_video` project. Create Family and Draft v1 in Settings → Recipe Library, select exact Active Profile and optional Active Skill/Verified Capability, add an Asset Plan template row, then activate. In the project card, open Recipe, preview the exact version, explicitly confirm Profile alignment if prompted, and bind. Verify that the exact Recipe/Profile and recommendation counts are shown without any project Skill, Storyboard, Model, Asset Plan, or Stage mutation. Create and activate Draft v2, confirm the first project remains on v1, then start a Stage and confirm replace/unbind is blocked. Do not use an accepted historical test project.

# General Video / Advertisement V0.1

This branch adds the first Dream Stream production profile on top of Toonflow v1.1.8.

## Representation

- `projectType = general_video`
- `type = advertisement`

No database migration is used. Existing `o_project.projectType` and `o_project.type` fields carry the profile.

## Compatibility contract

- Existing `novel` and `script` projects keep the legacy ProductionAgent skills and story-skill loading behavior.
- Advertisement projects use an isolated profile skill directory.
- Advertisement projects do not load `story_skills` into ProductionAgent art/production skill pools.
- Existing asset, scriptId, storyboard, vendor, socket and workbench contracts remain unchanged.
- One normal `o_script` row remains the compatibility production unit for V0.1.

## Explicit non-goals

- no database migration
- no Vendor changes
- no Storyboard/Workbench rewrites
- no ComfyUI integration
- no paid model calls during engineering verification
- no deployment or publishing

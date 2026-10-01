# Model Presets — DS-MODEL-001

Advertisement uses point-of-use model validation. Project creation, its Brief fields, Asset Plan, Asset Preparation and Gate do not require image/video models. Other profiles retain their existing model checks.

## Configuration

- `o_modelPreset`: UUID, name, JSON slots (`text`, `image`, `video`, `tts`). Values are existing `vendorId:modelName` references or null, never credentials or invented providers.
- `o_modelScope`: scope (`system`, `profile:advertisement`, `project:<id>`), optional presetId, JSON slot overrides. New tables initialize through the real database adapter transaction.
- Advertisement resolution per slot: project override > advertisement profile default preset > system default preset. Null means inherit. No preset means empty configuration, which still permits advertisement creation.
- New projects inherit dynamically; defaults are not copied into project rows. Existing imageModel/videoModel fields remain readable until explicitly migrated. Editing an unchanged inherited value does not pin it as a project override.
- Applying a complete preset copies all four slots into project overrides (null slots resume inheritance). Subsequent single-slot PATCH-like saves leave other slots untouched. Editing the original preset changes defaults referencing it, not previously copied project overrides.
- Text presets are used by the Production Agent; where no text preset is configured, existing per-agent deployment remains the compatibility fallback. This does not replace all historical agent configuration. TTS references and the existing audio runtime are supported; no new audio workflow is introduced.

## Authenticated POST endpoints

Base: `/api/modelSelect/presets`.

- `/list`: presets, selectable enabled-vendor models, profile/system defaults.
- `/save`: `{id?, name, slots: {text,image,video,tts}}`; create/update full combination.
- `/default`: `{scope: "system" | "profile:advertisement", presetId: UUID | null}`.
- `/project`: `{projectId, presetId}` to apply a full preset, OR `{projectId, slots: {image?: string|null, ...}}` to change supplied slots only.
- `/resolve`: `{projectId}`; effective models, source per slot and own overrides.
- `/check`: `{projectId, slot}`; point-of-use validation, no provider invocation.

Advertisement generation checks resolved model existence, vendor enabled state and matching model type before HTTP generation dispatch/writes. The shared image/video/audio runtime checks again before provider/task work. HTTP requests carrying a stale or different selected model are rejected clearly instead of silently invoking a different model; save the project slot or refresh first. Asset/Gate access is unaffected and existing Production Gate checks remain in force. UI video-generation preparation also checks its slot on entry.

## UI

Settings → 模型预设: create/edit a combination and select advertisement/system defaults. Advertisement Asset Preparation → 本项目模型配置: apply the full preset or save each slot independently. Empty/retired configuration remains visible; no placeholder models are inserted.

## Validation

`npm run test:model-presets` uses the actual runtime database wrapper and temporary SQLite, actual HTTP routes and generation handlers with provider probes only. Frontend tests mount the actual Vue preset component and execute the actual create/open/preparation handlers. No paid models are called. Existing backend/frontend regressions remain required. A passing build is not a full-repository type-check or full Gate Audit acceptance.

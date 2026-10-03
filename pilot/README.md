# Dream Stream V0.4 Project Agent Pilot

Status: **EXPERIMENTAL / NOT ACCEPTED**. This checkout and its `userdata/pilot/data` are separate from the accepted Toonflow installation. Do not point `TOONFLOW_DATA_DIR` at accepted userdata.

Run `start-v04-pilot.ps1` from this directory to start backend `10589` and frontend `50189` in hidden local processes. The launcher reads the sole account ID from the existing disposable database and enables Revision Confirm for that account. On a brand-new database it boots without Revision Confirm; after the first account exists, stop those pilot processes and run the launcher again. The exact data path and process IDs are printed, and logs stay in `v04-experiment/logs`.

Open <http://127.0.0.1:50189/#/studio> and sign in to the disposable experimental environment. Studio and <http://127.0.0.1:50189/#/professional> read the same project truth. The older `/#/pilot` bookmark redirects to Professional. Keep any real brand pilot project separate from development smoke projects already in this disposable database.

OPT-030 first version: Studio shows visual asset groups, confirmed reference images, storyboard cards, Project Agent, and the shared browser-session Review Center. A draft in sessionStorage is recoverable UI state, never authoritative truth. “确认所有正常项” runs the existing Visual Spec Preview and Apply sequentially, excluding warnings, stale revisions and incomplete items. The separate `/v04/agent/action-proposal` endpoint returns zero-write Visual Spec or Storyboard proposals. Shot acceptance uses the existing controlled Semantic Revision flow. Asset identity changes remain in Professional; the Studio Agent action returns a target-confirmation boundary for them. No image generation is added by this workspace.

Persistent Project Agent check (do this before continuing the broader pilot):

1. Open one experimental project in Creative. The center shows the confirmed Brief/Treatment/Script; the same Project Agent stays on the right. Discuss a specific visual direction. If no text model is configured, the chat explains the missing model at point of use; do not add a fake model.
2. Ask the Agent to propose a Brief edit, Treatment, or Script. Inspect the side-by-side diff and cancel once: the confirmed Creative content must stay unchanged. Generate again, inspect, and explicitly confirm one proposal. Manual editing remains behind **人工编辑当前内容** and uses the same preview/confirm path.
3. Upload one small PNG/JPEG/WebP using **＋ 图片** or drag it into the composer. Ask the Agent to analyze or compare it. Verify that the image appears in the message after refresh. If the configured model cannot read images, the message and image remain in history and the UI reports the model limitation; it must not claim an image analysis succeeded.
4. Switch Creative → Assets → Storyboard → Video → Edit, and return to Creative. Ask about the earlier discussion. The memory identity remains `project:<projectId>:projectAgent`; route, stage, unit, and selected object change only the current context. In Assets select a canonical asset, or in Storyboard select a shot, and ask for a targeted suggestion.
5. For a chat image, choose a use and inspect the separate preview before confirming. Project/Asset Bible/selected asset/shot references remain references, never production assets. To promote a selected canonical asset's image, choose **上传为选中素材的正式图片** and read the warning. Only this explicit confirmation copies the original uploaded bytes into the production asset, records server upload provenance, and binds the current unit's Asset Plan. Check REAL_REQUIRED/AI_ALLOWED and Gate status from the authoritative backend.
6. Reload the browser or reconnect. Earlier messages, images, reference decisions, and confirmed Creative remain. Open a second experimental project: its conversation and images must not appear in the first project's Agent.

No automated check calls a paid model. These are human interaction steps; passing automated tests and build does not constitute Pilot or product acceptance.

Suggested broader human pilot path:

1. Create the advertisement with a name, 30-second brief, duration and aspect ratio. The first workspace is Creative.
2. Set a text model only when you want to call Project Agent or an AI Skill. These explicit actions may incur provider charges; ordinary project/Creative/Asset Plan work does not.
3. Use the Project Agent to discuss Brief/Treatment/Script, then confirm each proposal through its preview. Propose and accept or reject durable project decisions.
4. Use manual or AI-assisted Asset candidates, inspect duplicate suggestions, edit the candidate, preview and confirm. Canonical IDs are assigned only on Apply.
5. For REAL_REQUIRED assets, use the existing Advertisement Asset Preparation page to upload and bind genuine source material. The unit Asset Plan is the authoritative numeric asset binding.
6. Draft Storyboards with Canonical IDs. Preview through the accepted Semantic Revision flow and confirm only after inspecting Stage and output impact. Complete required Stage and Supervisor actions in Production before media generation.
7. Continue through the accepted image/video Candidate review and Editor. The same Project Agent panel can be reopened there.

The local ONNX embedding model is optional in a fresh disposable database. Without it, Project Agent retains the raw project-level conversation, image references, and structured decisions, while vector recall is unavailable. Chat images are kept in a private `v04-conversation` data directory and served through a project-owner checked API, outside public `/oss`. The experimental Agent does not auto-generate rolling summaries or mutate production from chat. Only PNG/JPEG/WebP images up to 8 MB and four per message are supported. No paid model calls happen during startup or tests.

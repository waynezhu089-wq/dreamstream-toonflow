# Dream Stream V0.4 Project Agent Pilot

Status: **EXPERIMENTAL / NOT ACCEPTED**. This checkout and its `userdata/pilot/data` are separate from the accepted Toonflow installation. Do not point `TOONFLOW_DATA_DIR` at accepted userdata.

Run `start-v04-pilot.ps1` from this directory to start backend `10589` and frontend `50189` in hidden local processes. The launcher reads the sole account ID from the existing disposable database and enables Revision Confirm for that account. On a brand-new database it boots without Revision Confirm; after the first account exists, stop those pilot processes and run the launcher again. The exact data path and process IDs are printed, and logs stay in `v04-experiment/logs`.

Open <http://127.0.0.1:50189/#/pilot> and sign in to the disposable experimental environment. Create a new advertisement project there. Keep any real brand pilot project separate from development smoke projects already in this disposable database.

Suggested human pilot path:

1. Create the advertisement with a name, 30-second brief, duration and aspect ratio. The first workspace is Creative.
2. Set a text model only when you want to call Project Agent or an AI Skill. These explicit actions may incur provider charges; ordinary project/Creative/Asset Plan work does not.
3. Confirm Brief, Treatment and Script through their preview. Propose and accept or reject durable project decisions.
4. Use manual or AI-assisted Asset candidates, inspect duplicate suggestions, edit the candidate, preview and confirm. Canonical IDs are assigned only on Apply.
5. For REAL_REQUIRED assets, use the existing Advertisement Asset Preparation page to upload and bind genuine source material. The unit Asset Plan is the authoritative numeric asset binding.
6. Draft Storyboards with Canonical IDs. Preview through the accepted Semantic Revision flow and confirm only after inspecting Stage and output impact. Complete required Stage and Supervisor actions in Production before media generation.
7. Continue through the accepted image/video Candidate review and Editor. The same Project Agent panel can be reopened there.

The local ONNX embedding model is optional in a fresh disposable database. Without it, Project Agent retains the raw project-level conversation and structured decisions, while vector recall is unavailable. The experimental Agent does not auto-generate rolling summaries or mutate production from chat. No paid model calls happen during startup or tests.

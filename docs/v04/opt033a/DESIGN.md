# OPT-033A Design / implementation contract

Status: EXPERIMENTAL / HUMAN PILOT PENDING. No Stable merge or PR.

## Authority and compatibility

Project Asset identity, confirmed Visual Spec, Prompt IR and accepted 001E semantics remain authoritative and unchanged. Execution prompts, generated candidates and coarse observations are not Project Truth. Existing schema is reused; no schema files changed. Existing Professional Krea multi-view contracts retain their default routing. Only the new asset-pipeline resolver selects Klein when no persisted routing exists; explicit persisted routing is respected and incompatible routes pause/reject.

## New project setup

The user's free visual-style text is stored in the existing project artStyle field. Initial-project preparation is explicitly authorized by creation with that field. It grounds extraction in confirmed Treatment, or in the creation Brief when Treatment does not exist. The ordinary Skill API still uses its previous Treatment boundary; the Brief option is internal to initial preparation. Canonical ADD mapping uses the existing strict newAsset validator, existing Preview/sourceCreativeVersion/Apply guards and coverage compiler. Extraction-only fields never leak into persisted asset input. Existing identity merge references are not duplicated. Initial setup does not automatically accept a Director proposal or generate media before Director confirmation.

Director preparation retains GLOBAL_VISUAL_DNA, narrative role, scale, lineage and unit projection. No professional JSON form is required. A failed or abandoned initial preparation can be explicitly resumed; it rereads current state rather than blindly duplicating identities.

## DIRECTOR_REFERENCE_CONTINUITY_V1

A fresh Director is captured inside the same SQLite write transaction as baseline/candidate adoption. After the new Asset Bible reference, compare all non-reference source fields; every prior reference must be unchanged, and the delta must be precisely one reference to the adopted asset/attachment. Then append proposal/version/projection with exactly the previous Director intent. Evidence records inherited revision, reason, old/new reference hashes, semantic hash and automaticInheritance. Old records/statuses are untouched. Real Creative/asset/Director semantics changes fail closed and require reconfirmation.

A narrowly identical delta is also necessary when adopting a source-pinned derived reference, since it otherwise invalidates the Director merely by adding a reference. Its reason is DERIVED_REFERENCE_ADOPTION. It does not authorize arbitrary reference rebinding or stale Director resurrection. Job freshness compares Director semantic hash, so unrelated reference-only inheritance does not fence unrelated assets. Each view still pins its own exact current MAIN source and source hash.

## Krea MAIN and MAIN edits

New first drafts use KREA2_T2I_ASSET_V1. Existing usable MAIN is reused instead of gratuitously regenerated. Source/reference edits use existing Krea edit profiles. Render inputs contain source-defined identity facts, type guards, neutral single-subject presentation and a scoped Director projection. Blue night lighting/background is excluded from subject-reference presentation; confirmed palette remains. Dream Matter material constitution is inherited only through applicable source/lineage evidence; biological whale is excluded. BRAND/UI/REAL_REQUIRED never enter AI generation.

Agent modification produces an EDIT_CANDIDATE. Only human Preview/Confirm adoption appends baseline/reference. MAIN adoption queues new view candidates in the same transaction, marks obsolete view jobs STALE and preserves files/history. It never changes canonical identity or confirmed Visual Spec. Failed/rejected/stale results cannot become current through refresh.

## Klein independent views

KLEIN_ASSET_VIEW_V1 pins one current MAIN via LoadImage -> image scaling -> VAEEncode -> ReferenceLatent. Each view is a separate graph/prompt. Installed Q4 Klein, Qwen encoder and Flux2 VAE are checked against object_info. No download/install. Existing minimal graph keeps 4 steps / Euler / 768x1024; model/reference/prompt/profile versions enter frozen job identity.

Plans: HUMAN SIDE/BACK; CREATURE SIDE/BACK_3Q; ship SIDE/bow FRONT; other vehicle SIDE/FRONT/REAR_3Q; PROP SIDE. Environment/material/celestial do not receive fake subject-turnaround requirements. These roles denote candidates, not a guaranteed useful-view verdict. Ship stern/submarine rear can remain Attention. Human selection decides usable views.

## Generate All / recovery

Reuse existing persistent jobs, artifacts, traces and one leased worker. Setup phase journal is append-only in existing Decision storage, not a new task database. Preparation is claimed under a SQLite write boundary, Visual Spec batches are sequential and <=6, partial failure is retained, and job admission plus ADMITTED journal share the transaction. Before admission, recheck both preparation ownership and Director identity. Old results cannot append a new current phase. Refresh only reads pipeline/current and jobs; it does not call reconcile or generate. Identical admitted Director preparation deduplicates. In-flight unknown provider submission is not automatically repeated.

## Coarse QA / retry

Metadata check plus existing local CPU coarse inspector only; no external heavy Vision. Unavailable, missing checks or uncertainty -> Attention. Only HIGH-confidence explicit major/coarse failure permits one appended retry; original failed output retained. OOM recovery shares attempt budget. No automatic repair of subtle anatomy. MAIN Attention requires human adoption before automatic new Klein derivation; legacy usable MAIN compatibility remains. Every coarse PASS remains humanReviewRequired.

## Studio

Ordinary controls send Agent intents; persistent progress/Attention summary contains no workflow jargon. Purpose selection excludes STALE/CANCELLED IDs. Baseline reads expose stale status without rewriting historical baseline records. Professional keeps routing/trace/history. Pipeline state and candidate identity are project/script scoped; late responses cannot overwrite another scope.

## Limits

One worker is deliberately serial. Initial/preparation is asynchronous within backend and journals phases; abrupt process death leaves a bounded abandoned preparation requiring explicit resume (initial setup requires a provably dead owner after the bounded window; unknown legacy owner is fail-closed), not a general exactly-once model task engine. Existing-project stale Director is never globally repaired. Local coarse inspector must be proven/configured; current machine's probe was unavailable, so real candidates are Attention. Frontend type-check is blocked by existing TS5103. No mainline integration is authorized yet.

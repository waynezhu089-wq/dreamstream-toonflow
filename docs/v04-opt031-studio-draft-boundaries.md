# OPT-031 Studio Draft boundaries (Phase 0/1)

This experimental Studio flow leaves the existing authorities intact:

| Record | Meaning |
| --- | --- |
| `o_v04Asset` | Canonical asset identity and revision. |
| `o_v04AssetVisualSpec` with `CONFIRMED` status | Authoritative visual specification. |
| `o_v04AssetPromptBuild` with effective `READY` status | Prompt derived from a confirmed visual specification. |
| `o_v04AssetReviewPlan` | Unit-scoped generation intent and preview plan. |
| V0.4 Proposal Workspace | Session-scoped, non-authoritative drafts. |

`/v04/visual-spec/draft-prompts` accepts at most six scoped draft specifications. It validates current asset revision and real-reference restrictions, reads the current Review Plan, then calls the same pure `intentFromReviewPlan`, `compilePromptIR`, and `renderGenericPrompt` functions as the confirmed path. It returns compilation results without inserting or updating Visual Spec, Prompt Build, or asset identity rows. The Studio package is stored only in Proposal Workspace/sessionStorage, with an explicit draft stage and source revision. Real-required assets never enter this AI draft route. A future image executor may consume this package; none is started in Phase 1.

Before Phase 1 changes, backend tests passed 337/337 and frontend tests passed 138/138 when backend linked dependencies were accessible. The standard frontend type-check was already blocked by `TS5103` in `tsconfig.app.json`; Vite build remained available as a separate check.

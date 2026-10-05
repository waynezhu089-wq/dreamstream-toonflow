# Night01 Implementation Tickets
Status: DESIGN_INTENT / NOT_FROZEN; only OPT-031 Phase A implemented.
Naming decision: OPT-031/OPT-030 already label prior Studio Auto Asset/UI. Use NIGHT01-qualified numbers here; Wayne must settle IDs before tracking. Never rewrite old tickets.

| Ticket | Goal / dependencies | Schema/backend/frontend | Migration / tests / human pilot / stop |
|---|---|---|---|
| NIGHT01/OPT-031 Director Intelligence V1 | Candidate + inspection; existing Creative/assets | PhaseA pure schema/compiler/read-only endpoint; Professional tab | No DB migration. HTTP zero-write/auth/hash drift, strict scope/relations, mounted race guards. Human review dry-run. Stop before accepted version/persistence/generation. |
| NIGHT01/OPT-032 Asset Design System V2 | Hero vs reference; reviewed Director policy/jobs | Concept purpose + source-linked extracted views only if needed; current gallery | Preserve legacy MAIN, no false labels. Test source/view provenance/stale parents/dedup. Real multiview pilot. Stop if replacing media/Truth store. |
| NIGHT01/OPT-030 Multi-View V2 | Identity+view control; reference packs/QA | Existing role jobs, adapter-isolated changes; Lightbox | Preserve previous purposes. Nonhuman DERIVE routing separate prerequisite, untouched. Frozen reference drift/job dedup tests; actual FRONT/SIDE/BACK pilot. Stop on identity/view failure. |
| NIGHT01/OPT-033 Shot Director V1 | Beat→composition plan; approved Director + bindings | Candidate shot compiler through B3 Preview; existing Confirm/recovery UI | Later Source/hash integration requires separate contract. Scope/null/stale/zero-write tests. Real beat-vs-shot pilot. Stop before unreviewed authorization integration. |
| NIGHT01/OPT-034 Visual QA V1 | Evidence recommendation; artifacts/approved constraints | Report JSON first; pure validator, optional later vision; per-image review | No first-phase DB store. UNKNOWN!=PASS/mock drift tests/no writes. Human adjudication. Stop before paid vision/auto-retry. |

Sequence: review dry-run → Director acceptance/Logo decision → separately freeze PhaseB → hero/reference roles → view+QA evidence → explicit shot integration. Do not implement all five tonight. Stable and accepted safety kernels stay unchanged.

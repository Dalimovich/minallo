# Remaining reliability work

Assessment after `436cf76`, 2026-09-11. Confirmed P0/P1 fixes in this audit have executable passing regressions. These remaining items are coverage gaps or P2 work unless a fresh execution proves a normal-user failure.

| Item | Evidence / priority | Required next evidence |
|---|---|---|
| Complete the 25-journey acceptance gate | Acceptance gap | Exact ExamForge Saved reopen, Flashcards confirmation through generation, recommendation launch, successful visual-page interpretation, and numeric calculation completion need complete journey assertions beyond helper/routing tests. |
| Full-document interruption and resume | Acceptance gap | Existing extraction test executes a supplied checkpoint; prove actual interruption, persisted checkpoint reload and resume without duplicates. Summary processing is separate from extraction resume. |
| Mid-token chat switching and regenerate after changed scope | Coverage gap | Current browser switch occurs during delayed submission; add browser assertions during actual token delivery and regenerate. Transport snapshot regressions already pass. |
| Uniform request terminal diagnostics | P2, requested diagnostic contract incomplete | Emit one record matching the outward terminal with all 14 requested fields. Current records are dispersed; inner `terminal_event_emitted(done)` occurs before final freshness checks. Privacy allowlist is fixed. |
| Default optional retrieval semantics | P2 | Current recovery uses `needsCourseEvidence` to distinguish default retrieval from required evidence. Represent the distinction in the canonical evidence contract when changing routing next. Current recovery regressions pass. |
| Document health boundary injections | Coverage gap | Add missing-embedding and actual storage disappearance during generation injections; see the detailed injection matrix. |
| Hidden viewer lifecycle | P2, no normal-close failure reproduced | Reproduce through actual open/close UI before changing authority rules. |
| Model and deployed-service verification | Acceptance gap | Run approved test-user journeys through actual deployed auth, index, retrieval, provider, persistence and Saved reopen. This audit did not deploy or exercise live user data. |

Do not expand this into another architectural redesign. Close concrete acceptance gaps, then freeze once the requested gate passes. Reopen frozen behavior only for a reproduced user issue, regression failure or new functionality that changes it.

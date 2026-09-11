# Consolidated AI reliability findings

Historical serialized fix queue. For implemented fixes, follow-up findings, latest test results and acceptance limits, see [the final audit report](AI_RELIABILITY_AUDIT.md).

Audited SHA: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`. Initial investigation completed before production edits. Three investigators covered requested roles 1–7, 9–10; coordinator covered roles 8, 11–12. Expanded campaigns were interrupted by agent usage limits and are being completed locally. This report is the serialized fix queue, not an acceptance verdict.

| ID | Severity | Shared root cause | Demonstrated reproductions | Planned structural fix |
|---|---|---|---|---|
| R1 / STATE-01 | P0 | Async request construction reads mutable active-chat source settings | A selected-document request takes B's Internet/all-files mode after capture; retry restores old settings over newer choices (source proof) | Authoritative immutable request snapshot throughout submission/retry; validate captured viewer identity |
| R2 / ROUTE-1 | P0 | Fast execution is chosen before explicit evidence constraints | Internet selection returns model-only answer; selected scope can be bypassed by same shortcut | Feed explicit web/selected constraints into canonical planning before early exit |
| R3 / AUTH-01 | P1 | Browser adapter treats a valid expiry as proof a rejected token is valid | 401 -> zero real refreshes -> same token retried | Force refresh for rejected token; reuse a newer token when another request already rotated it |
| R4 / SSE-01 | P1 | Transport/terminal paths do not share terminal ownership and partial-answer preservation | Native read failure loses received text; done still reads until socket EOF (deterministic code proof) | One terminal boundary; preserve buffered answer for transport failure; stop consuming after done/error |
| R5 / CONV-1 | P1 | Execution lane is incorrectly used as answer provenance | Grounded answer -> clarification -> verification becomes general | Preserve inherited grounded scope on contextual completion and persistence |
| R6 / FULL-1 | P1 | Input page availability is counted as successful model processing | Empty map and synthesis yield complete coverage | Validate each batch and final output; count only successfully processed pages; typed bounded failure |
| R7 / VIEWER-01 | P1 | Optional viewer capture is mandatory before evidence resolution | Unrelated formula question blocked by failed PDF capture | Carry optional capture failure to authoritative evidence routing; fail only when that evidence is required |
| R8 / ERROR-01 | P1 | Retry permission suppresses independent recovery actions; transport codes disagree | session_expired/access-revoked have action none; SESSION_INVALID becomes generic retry | Preserve sign-in/reopen actions and central typed mappings |

All fixes require executable failing tests before production changes, focused/cross-system verification, then final complete verification. Source-only companion scenarios remain explicitly labeled. No phrase-specific routing patches.

P2/backlog: hidden viewer eligibility pending normal-close reproduction; selected generation with an indexing member can omit that member; deployed index activation/Saved reopen require live verification; observability fields are dispersed; three unused Python test imports. Detailed reports: `findings/`, `error-contract.md`, `test-coverage-gaps.md`. Remaining risks will be consolidated in `AI_RELIABILITY_BACKLOG.md`.

Acceptance stays **NOT READY TO FREEZE** until all demonstrated P0/P1 regressions and critical runtime journeys pass. Mocked tests alone cannot establish deployment or live AI correctness.

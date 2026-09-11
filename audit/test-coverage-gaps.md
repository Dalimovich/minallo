# Test coverage quality

The baseline's 568 Node and 1563 Python passing tests do not establish end-to-end AI reliability.

| Behavior | Evidence class | Practical limit |
|---|---|---|
| Chat submission, source controls, many Saved/viewer contracts | SOURCE REGEX/WIRING | Reading shell.ts and assert.match cannot prove async ownership or DOM behavior. |
| SSE parser split/duplicate framing | REAL UNIT EXECUTION | Does not execute fetch/read rejection through the shell. |
| Auth refresh and retry | REAL UNIT EXECUTION | Most tests inject refreshSession; bypass the broken browserRefresh adapter. |
| Conversational evidence route tests | INTEGRATION | Real route, mocked generation/storage; comments calling these “real end-to-end” overstate evidence. |
| 20-turn route persistence | INTEGRATION | Fixed mocked source/answer on every turn; strong stale-generation and region identity checks, not semantic understanding. |
| Natural paraphrase generalization | MISSING live execution | Six tests use unconditional skipif(True), even if a live key exists. |
| Full-document coverage | REAL UNIT EXECUTION / INTEGRATION | Mocked model fixtures do not cover empty map or synthesis results at baseline. |
| Index replacement | REAL UNIT EXECUTION / HELPER-ONLY | Does not prove actual Supabase revision activation transaction or failed replacement against a deployed index. |
| ExamForge answer validity and persistence | INTEGRATION | Useful exact-answer invariants against fake DB/model; exact Saved reopen in browser remains distinct. |
| Existing tests/e2e/13-chatbot.spec.ts | INTEGRATION in a real browser | AI endpoint mocked; auth setup requires live credentials. It cannot substantiate live RAG/model claims. |
| Real student prompt -> live model/retrieval -> Saved reopen | REAL E2E: not yet executed | Must remain an explicit acceptance gap until executed. |

New regressions must run the failing code, not assert its source contains a proposed fix. AST-extracted execution is labeled integration with mocked boundaries, not full application execution. Browser tests using synthetic HTTP responses are labeled browser integration, not live AI E2E. Skipped, designed-only, and mocked model answers must never be reported as successful real-model journeys.

History/report claim reviewed: `tests/test_conversational_evidence_resolution.py` describes mocked route tests as “real end-to-end”. The tests' actual body stubs stream_general_answer, tutor state, retrieval, and cache. The qualification in this report corrects that claim; no commit-message claim is treated as evidence without execution.

# Final coverage review

Read-only production investigation, 2026-09-10. Compared the original attached request with current permanent tests, audit runners, and full-document processing. This review does not treat a test's name as proof of its scope.

## Finding FULL-2: truncated model output claims complete coverage

### Severity
P1

### User scenario
A student requests a full-document summary or extraction. A map or synthesis completion reaches its output token limit and returns nonempty partial text with `finish_reason='length'`.

### Expected
Continue within a bounded policy or return typed recoverable failure. Do not report the partial output as complete exhaustive processing.

### Actual
The real model adapter returns the text without examining the finish reason. The real processor counts the map as successful and reports final complete coverage when synthesis text is nonempty, including truncated text.

### Evidence
Executed `audit/repros/test_full_document_truncation.py`: **1 passed**, asserting the defect. The probe executes both `notes_full._call_openai` and `process_full_documents`; provider and database boundaries are mocked. It supplies `finish_reason='length'` and proves `coverageResult.complete=True`. This is integration evidence, not live model E2E. It is a baseline defect probe, not a permanent safety regression.

### Root cause
Provider completion validity is discarded at the adapter boundary. Page availability and nonempty generated text are necessary but insufficient evidence of completed processing.

### Files
`backend/python-ai/app/routers/notes_full.py::_call_openai`; `backend/python-ai/app/services/full_document_processing.py::process_full_documents`.

### Structural fix
Validate provider finish status at the adapter boundary; propagate a typed recoverable processing failure or bounded continuation before declaring page/final coverage complete. Preserve existing callers' API where practical.

### Regression test
Separate truncated map and truncated synthesis fixtures through the real adapter, asserting no successful complete result. Exercise the full-document SSE branch to assert one typed error and usable recovery.

### Related findings
FULL-1/R6 fixed empty map and synthesis output but did not validate truncated output.

## Evidence reconciliation

The 50 scenarios in `audit/student-journeys.json` execute real dialogue/evidence/document-access/execution-router logic with synthetic previous assistant answers. The semantic model is forced to time out when the production gate calls it. They do **not** execute source routing, retrieval, terminal handling, generated visible answers, or Saved reopen. Events such as document deletion, worker interruption, auth expiry, and reload are explicitly recorded as **not injected**. These are 50 resolver scenarios, not 50 completed student journeys.

`audit/critical-journey-execution.json` records 285 backend passes/6 skips and 60 frontend passes at SHA `f5ca1624e362ec9da9b6e2ed1a75385f1a782829`. This predates several subsequent fixes and is not final verification. Its runner correctly labels mixed evidence, but is a broad module selection rather than a compact assertion of 25 complete journeys.

The real-browser harness uses the actual chat shell with mocked HTTP fixtures. This is browser integration evidence. It can establish DOM lifecycle behavior and local persistence, but cannot establish production auth, live retrieval, real generated artifacts, or deployed Saved reopen. Its coordinator is rerunning remaining switching cases; inspect the final artifact rather than assuming this report's observed snapshot is final.

| Required journey group | Strongest inspected evidence | Remaining limit |
|---|---|---|
| General/grounded clarification and verification | Real endpoint integration with mocked model/storage; provenance hydration runtime tests | No live model paraphrase campaign; source-specific exact wording failures must still be assessed |
| Explicit Internet / selected-document routing | Real endpoint preflight integration and actual frontend transport execution | No real indexed selected-file browser journey |
| PDF open with unrelated or visual question | Endpoint integration plus actual transport function execution | Real PDF capture/revision changes in browser not established |
| Full-document scan | Real processor with fake database/model, 1/100-page and missing-page tests | Provider truncation defect above; no actual 100-page PDF E2E |
| Interrupted full-document resume | Scoped extraction deduplication helper tests and source wiring | `test_scoped_job_resumes_without_duplicates` only calls `deduplicate_scope_items`; it does not interrupt/restart a worker or verify checkpoint persistence |
| General/course calculations | Routing tests and synthetic campaign | Model answer correctness and grounded numeric provenance not established by routing |
| Study recommendations | Real recommendation helper tests | With/without-course browser generation and persistence not established |
| Flashcards confirmation | Dialogue/task tests and synthetic campaign | Confirmation through generation, validation, Saved reopen not established |
| ExamForge exact Saved reopen | Fake-DB generation/persistence tests and frontend source wiring | Exact saved session/questions/verified answers reopened in actual browser is missing |
| Stop/next, pre/post-token failures, reload, chat switch | Transport runtime tests and actual browser with synthetic SSE | No deployed interrupted-stream lifecycle test |
| Expired/rejected access token and revoked refresh | Real browser-adapter execution with fake auth/network | No live Supabase revocation or cross-tab test |
| Structured model failure | Injected malformed semantic outputs; ExamForge verifier tests | Each feature's invalid action/structured output boundary is not covered by semantic validation alone |

## Full-document coverage after R6

Confirmed meaningful permanent tests: empty/whitespace map is unprocessed; empty synthesis fails aggregate completeness; page 40 missing from a 100-page fixture prevents any model call; successful 100-page fixture reports exact cumulative progress. These execute the real processor and are valuable regressions. They do not demonstrate actual exhaustive content quality, durable full-document summary resume, revision change during a worker run, or a provider truncation policy.

Do not infer that a scoped-extraction job's checkpoint mechanism automatically covers the separate `exhaustive_document_stream` summary path. The latter directly launches `process_full_documents` in a thread and emits its result. The processor has no checkpoint/job parameter. Whether retry restarting work is acceptable should be described explicitly; a claimed halfway resume needs an executable checkpoint test.

## Acceptance recommendation

**NOT READY TO FREEZE at this review point**: FULL-2 is an executed normal-user P1, and required actual full-document resume / exact Saved reopen journeys lack runtime evidence. Fix and rerun the concrete defect first. Complete a compact critical-journey matrix with exact test identifiers and evidence classes; do not promote helper/source checks to end-to-end passes. Live production deployment verification remains separately unexecuted.

# Final conversation and deferred terminal review

Read-only production audit, 2026-09-10. Reviewed the in-progress R9 diff and deferred `early_stream` after the first eight fixes. No production changes made by this reviewer.

## Deferred terminal ownership remains incomplete (P1)

`backend/python-ai/app/routers/stream.py` sets `terminal_event_sent` upon `_is_terminal_sse(event)` (around line 2722), persists completion/error, and yields the event (around line 2769). It then unconditionally starts another iterator read. The flag only suppresses synthetic EOF and generic-exception terminals; it does not stop consumption or forwarding.

Concrete consequences from control flow:

- Provider sequence token, done, token forwards a token after completion.
- Provider sequence token, done, error forwards two terminals.
- Provider sequence token, done, `TimeoutError` enters the timeout conversion and unconditional `TutorPipelineError` handler, producing an error after done and overwriting the durable completion state.
- A provider that remains open after done keeps the response alive and can emit heartbeat/status events after completion.
- A done event without any useful answer is persisted as completed, unlike the hardened fast lane.

The existing `test_fast_stream_terminals.py` validates the fast branch only. The new `audit/repros/test_final_conversation_review.py` executes the deferred endpoint using explicit-web routing and separate SSE frames from an async synthetic provider. All five deferred regression cases fail before correction: done followed by token/error/timeout, error followed by done, and empty done. Assertions require exactly one terminal, no postterminal output or provider advancement, and a typed empty-completion error. Break after forwarding the terminal and ensure generator cleanup cannot overwrite completed status as interrupted. This is endpoint integration evidence, not live-provider or browser evidence.

Also inspect cancellation at the yield boundary: `CancelledError` unconditionally persists interrupted/failed even if a terminal has already been recorded. A consumer stopping immediately after terminal must leave durable completion intact.

## Semantic follow-up gate review

The change removes the incorrect assumption that recognizing an explain/compare task resolves its referent. Preserving the explicit task in outage fallback is consistent with the request. `audit/r9-after.log` records 140 passing focused tests and six skipped tests. These execute mocked route/classifier boundaries; the skips are not successful live checks.

The structured response validation now rejects nonobjects, nonboolean continuation fields, and nonstring resolved requests. One remaining malformed-output hole is confidence: `max(0.0, min(1.0, float(value)))` converts NaN and positive Infinity into 1.0, and accepts boolean true as 1.0. This was reproduced with the repository Python interpreter. Python JSON parsing accepts NaN/Infinity, so invalid model JSON can become maximally trusted. Require a numeric, nonboolean, finite value within the documented range, otherwise use the established safe fallback. Extend malformed-output tests with NaN, Infinity, true, and out-of-range values.

The new grammatical referent detector includes `one`. Test standalone explicit subjects containing that word (for example, a question about a one-dimensional harmonic oscillator) under semantic-service outage so broad eligibility cannot silently inherit the unrelated prior topic. This is a suggested boundary regression, not a confirmed user-visible failure.

## Evidence limits

This review does not establish live model quality, actual production SSE transport behavior, or persisted production conversation recovery. The endpoint regressions should be reported as integration tests with synthetic providers.

## Executable evidence

From repository root in PowerShell:

```powershell
$env:PYTHONPATH='backend/python-ai'
backend/python-ai/.venv/Scripts/python.exe -m pytest audit/repros/test_final_conversation_review.py -q
```

Initial result: 9 failures in 2.56 seconds, recorded in `audit/final-conversation-review-before.log`. Five are deferred endpoint failures and four are malformed-confidence failures. The four confidence cases were also promoted to `backend/python-ai/tests/test_semantic_followup_gate.py` at the coordinator's request and confirmed failing (4 failed, 10 deselected; `audit/semantic-confidence-before.log`). No production code was edited by this reviewer.

## Grounded exception recovery silently substitutes general evidence (P1)

`retry_as_fast_contextual` excludes explicit document IDs, visible/full access, and the web lane, but does not exclude explicit `course_files` mode or a canonical `COURSE_RETRIEVAL` evidence requirement. Therefore an unexpected preparation failure can produce an ungrounded completed answer for a request that explicitly requires course evidence.

`audit/repros/test_grounding_failure_fallback.py` confirms three failures with the real endpoint and injected preparation/provider boundaries: course-files mode with a factual question, verification after a grounded answer, and current-message wording asking what the course files say. All call the general provider and emit its substitute. Initial result: 3 failures in 2.13 seconds; `audit/grounding-fallback-before.log`. Use the same invocation above with this filename. Structural recommendation: disallow fallback whenever the canonical evidence contract requires retrieval; consider removing this historical heuristic recovery now conversation-only routes are resolved explicitly before retrieval.

The same probe includes `test_deferred_error_terminal_survives_state_write_outage`: a durable request successfully starts, then state writes raise `OSError` during an injected typed pipeline error. This passes and retains exactly one typed error terminal. Thus no ordinary persistence-exception terminal loss was reproduced in the deferred helper; it retries twice and logs failure without swallowing the SSE terminal. This does not establish durable success during a database outage.

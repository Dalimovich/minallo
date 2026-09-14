# SSE / request lifecycle audit

Audited SHA: 1ecddd6b1beaa19a1c633160ef651c2fbd78511f. Production unchanged.

## Finding SSE-01
### Severity
P1
### User scenario
Student reads a partial explanation, then connection drops with a native reader/network error.
### Expected
Keep received text, mark interrupted with accurate transport recovery, allow next prompt/Continue.
### Actual
streamFromAskStream throws raw TypeError without partialAnswer; streamAiReply catch sets partialText to empty and overwrites assistantMessage.text. Received work disappears and reload retains the empty failed response.
### Evidence
Executed `node --import tsx audit/repros/stream-network.mjs`. TS AST selects the real streamFromAskStream and AskStreamError production functions, transpiles them and executes with mocked transport/render dependencies. Inject first token then reader TypeError: assistantMessage has received text, thrown error has no metadata. Source-deterministic outer catch proves clearing (lines 1622-1631). This is real function execution, not browser E2E.
### Root cause
Only explicit backend/error/EOF/watchdog paths attach answerBuf. Native reader rejection bypasses the error normalization boundary; outer catch preserves existing text only for user Stop.
### Files
frontend/js/features/chatbot-new/shell.ts: streamFromAskStream reader.read().then(resolve,reject), streamAiReply catch.
### Structural fix
Normalize all stream transport exceptions at the buffer owner into typed error with partial answer, request identity and stage; preserve partial in outer owner for any interruption. Cancel pending reveal/commentary timers when stream terminates.
### Regression test
Execute full stream owner with token then TypeError and assert persisted assistant text, interrupted state, recovery action, released composer, no delayed rendering. Also failure before token, typed backend error, malformed frame, EOF without done and empty done.
### Related findings
Thrown parser/reveal exceptions can follow the same text-losing path. Live reveal disposal after errors and pending commentary timers require runtime coverage.

## Coverage and limits
Existing focused suites 33/33 pass. Most shell lifecycle tests are source-regex assertions and do not execute Stop/chat switching/Retry. Actual SseParser implements incremental frame parsing, but doneMeta does not terminate read loop: EOF is awaited even after done, so trailing errors can override completion (source-only concern, not promoted separately without realistic transport reproduction). Empty completed responses and EOF missing done explicitly emit typed errors by source inspection. Mismatched event identity and aborted controller are checked before event processing. Stop immediately releases controller ownership; finalizer checks controller identity. Duplicate tokens have no IDs/dedup contract (backlog unless replay is demonstrated). Watchdog bounds unchanged nonempty stages; actual timeout/jitter and durable persistence recovery were not executed in this investigator.

STATE-01 in chat-state.md also affects stream request scope during asynchronous preparation.

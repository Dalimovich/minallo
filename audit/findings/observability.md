# Observability follow-up audit

Read-only source inspection plus synthetic execution of `PipelineObserver`; no real user content or live traffic inspected. Line numbers refer to this audit checkout.

## P1: Dialogue logging includes private message contents

`stream.py:3157` expands `dialogue.to_api()` into `observer.event('turn_resolved', ...)`. `DialogueResolution.to_api()` uses `asdict` (`dialogue_state.py:451`) and includes `original_message`, `resolved_request` and `referent_text`. The observer's three-key blacklist (`pipeline_observability.py:41`) does not remove those fields. Consequently ordinary deferred requests log user text and potentially quoted document/context text.

Synthetic execution confirmed this: `PipelineObserver('synthetic-request').event('turn_resolved', original_message='SYNTHETIC_PRIVATE_SENTINEL', resolved_request='SYNTHETIC_DOCUMENT_EXCERPT', task_family='explain')` emitted both sentinel strings into the actual logger.

Small improvement: use an explicit metadata allowlist for approved scalars/enums/counts and approved scalar lists, and replace whole-dialogue expansion with the required routing enum fields. Do not merely add three more forbidden keys: future nested structures and renamed text fields would bypass that blacklist. A `caplog` regression should assert routing information remains and sensitive sentinel strings are absent for both top-level and nested inputs. Avoid blanket logging exception messages from model/service failures when their contents are uncontrolled.

## P2: Terminal logging is incomplete and can claim success before rejection

Only the deferred preparation path constructs `PipelineObserver` (`stream.py:2934`). Fast general and early full-document/preflight streams return before that path. The deferred close log reports `terminal_event_sent` rather than the terminal outcome. In the inner stream, `terminal_event_emitted(done)` is emitted at line 6168 *before* generation freshness rejection and later authorization/persistence checks. A superseded request can therefore record done before yielding an error.

| Required field | Actual evidence | Gap |
| --- | --- | --- |
| requestId | `request_id` in most timing/error logs; observer envelope | Selection diagnostic at line 5363 omits it; not universal |
| conversationId | Durable identity restoration log, only when restored | No consistent request/terminal envelope |
| taskFamily | `turn_resolved` snake-case data and downstream camel-case event | Deferred only; not attached to failure record |
| relation | Whole-dialogue observer event | Deferred only; currently privacy-unsafe expansion |
| speechAct | `speech_act` in whole-dialogue event | Same gap |
| evidenceRequirement | `evidence_requirement` in whole-dialogue event | Same gap |
| executionLane | Fast latency log; assorted routing logs | No common terminal record |
| sourceScope | Selected-scope diagnostic and SSE metadata | SSE metadata does not establish terminal-log coverage |
| documentAccess | Branch-specific commentary/SSE access metadata | No consistent log field across lanes |
| selectedDocumentCount | `documentCount`, authorization counts, selection diagnostic | Names/meaning vary; selected count differs from retrieved/authorized count |
| failureStage | Typed deferred `tutor_pipeline_failed` log | Generic/full/preflight paths incomplete |
| errorCode | Typed deferred failure, branch-specific messages | Not universal; SSE/DB fields are not terminal logs |
| recoveryAttempted | `repair_completed` with attempts/success in a specific repair branch | No normalized attempted flag across recovery paths |
| terminalState | Deferred close boolean, inner `terminalEvent=done` | Missing across early routes; success logged prematurely |

Small improvement: one privacy-minimal terminal emitter with a fixed schema, shared by fast, full-document, early typed failures and deferred output. Initialize routing values from preflight and explicit scope; use null/unknown where not resolved rather than inventing a route. Emit the terminal state from the outward event actually committed, after final freshness/access checks, and emit interrupted/cancelled when output ends without one. Keep selected input count separate from retrieved or authorized count. Track real recovery attempts, not merely offered Retry controls.

Suggested executable regressions: capture logs from actual route tests for fast success/failure, full-document coverage failure, deferred success/error, superseded generation and cancellation. Assert exactly one terminal record, all required schema keys, correct emitted outcome, and absence of synthetic question/document sentinels. Existing focused route tests can supply transport/model seams; no live provider is needed to validate logging behavior.

## Assessment

Current logs do not satisfy the requested uniform diagnostic contract. The privacy leak is directly reproduced; missing/early terminal coverage is established by source inspection. This report does not claim that historical production logs were accessed or contained any specific user's data.

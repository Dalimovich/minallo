# Failure injection evidence matrix

Reviewed 2026-09-10 by read-only coverage investigator. This inventories inspected executable bodies, not a fresh full-suite run. Paths below are relative to `backend/python-ai/tests/` (Python) or `tests/frontend/` (JavaScript), unless prefixed `audit/`. Final run logs determine pass status. No listed test uses live model/database E2E.

Classes: **I** = real integration path with mocked boundaries; **U** = real unit execution; **H** = helper only; **W** = source text/wiring assertions; **B** = actual browser with synthetic HTTP; **GAP** = requested injection not established. A nearby test does not close a gap unless it actually reaches that boundary.

## Every pipeline boundary

| Boundary failed | Exact evidence | Class and limit |
|---|---|---|
| Browser submission | `ai-request-scope-runtime.test.mjs`: `chat switch during PDF capture retains the submitted source mode and selected scope`; browser harness `switch-before-submission` | I/B; async delay and switch, not a thrown submit-handler/render exception |
| Authenticated request | `auth-browser-adapter.test.mjs`: `revoked refresh surfaces a session error and never retries without authentication` | I; real adapter, fake Supabase/network |
| Dialogue resolution | `test_conversational_evidence_resolution.py::test_semantic_resolver_exception_falls_back_to_conversational_not_rag` | I/U; resolver failure fallback; independent deterministic resolver crash injection GAP |
| Semantic model | `test_semantic_followup_gate.py::test_known_task_family_still_resolves_contextual_referent_on_model_outage` | I; injected timeout with real endpoint and fallback |
| Evidence resolution | `test_optional_viewer_evidence.py`; `test_conversational_evidence_resolution.py::test_explicit_grounded_request_failure_stays_typed_not_silently_general` | I; absent required visual evidence / grounded failure. Latter explicitly permits failure before injected retrieval, so does not prove retrieval callback reached |
| Execution routing | `test_explicit_evidence_preflight.py::test_explicit_scope_cannot_exit_through_general_shortcut` | I; forbidden shortcut assertion, not router exception injection |
| Document lookup | `test_document_health.py::test_supabase_failure_maps_to_unknown_not_a_raised_exception` | I; fake DB failure in health lookup; actual ask-stream authorized lookup outage GAP |
| Embeddings | No inspected executable missing-embedding-service injection | GAP; embedding cache tests do not simulate outage |
| Retrieval | `test_flashcard_diagnostics.py::test_empty_retrieval_returns_typed_failure` | I; actual generator with empty retrieval. General chat retrieval-exception reachability not proven by nearby grounded failure test |
| Answer model | `test_fast_stream_terminals.py::test_fast_provider_requires_nonempty_answer_and_terminal_confirmation`; `test_full_document_failures.py::test_empty_synthesis_is_a_failure_even_when_all_page_maps_succeeded` | I; fake provider output, real route/processor |
| SSE | `ai-terminal-runtime.test.mjs`: `native read rejection preserves the partial answer in a typed recoverable error` | I; actual extracted transport, fake reader |
| Persistence | `test_examforge.py::test_generate_examforge_session_insert_failure_returns_error`; `saved-reply-sync-engine.test.mjs`: `a network failure (fetch rejects) marks the reply failed, not dropped` | I/U; fake storage/network, real persistence orchestration |
| Frontend render | `ai-actions-render.test.mjs`: `malformed JSON renders nothing and does not throw` | U; actual renderer input rejection, not arbitrary DOM failure; injected DOM/render exception GAP |
| Next-turn provenance | `test_answer_provenance_journey.py::test_grounding_mode_alone_is_not_downgraded_by_absent_optional_source_scope`; `chat-provenance-hydration.test.mjs` | U/I; missing metadata and real hydration; not live reload/backend roundtrip |

## Document and viewer injections

| Requested injection | Exact evidence or explicit gap |
|---|---|
| Ready metadata, zero chunks; stale chunk count | I: `test_document_health.py::test_stale_metadata_detected_when_chunk_count_lies`, `test_missing_chunks_when_metadata_also_claims_zero` use fake counted rows |
| Failed candidate reindex preserves good active index | H: `test_mark_failed.py::test_preserve_active_keeps_processing_status_untouched` captures update payload. Actual failed replacement transaction with real DB GAP |
| Missing manifest page | U/I: `test_index_manifest.py::test_manifest_requires_every_physical_page_exactly_once`; `test_full_document_failures.py::test_page_40_missing_from_100_page_pdf_never_falls_back_to_available_subset` |
| Document deleted after answer | GAP for sequence; I `test_document_health.py::test_missing_document_reports_failed` covers absent row only |
| Selected document still indexing | I `test_document_health.py::test_in_flight_status_reports_indexing`; selected-chat UI sequence GAP |
| Renamed document; similar filenames | GAP for actual rename/identity sequence; H `test_retrieval_phase8.py::test_doc_name_match_requires_specific_filename_signal` and `test_named_document_gets_strong_anchor_boost` cover ranking only |
| Course changed; old PDF after chat switch | I `ai-request-scope-runtime.test.mjs` tests captured scope and rejects replacement document; B `switch-before-submission` tests original source mode. Real viewer cross-course UI GAP |
| Missing embedding service | GAP |
| Zero relevant chunks | I `test_flashcard_diagnostics.py::test_empty_retrieval_returns_typed_failure`; chat selected-PDF no-match journey GAP |
| Page 7 to 8 / old snapshot late | I `ai-request-scope-runtime.test.mjs`: `late capture from another document cannot replace the submitted viewer evidence`; actual page-number-only race GAP |
| Viewer closed during request | GAP; scenario named in campaign is not injected |
| Same visible text, image changes | GAP for actual image swap |
| Visual extraction/capture failure | I `optional-pdf-capture-runtime.test.mjs`: both named cases execute real transport with capture failure; `test_optional_viewer_evidence.py` executes required/optional evidence route |
| Deictic formula and unrelated general question | I required/optional tests above; real PDF rendering and source image interpretation GAP |

## Full-document injections

| Requested scenario | Evidence |
|---|---|
| 1 page / 100 pages / missing page 40 | I `test_full_document_failures.py` (real processor, fake rows/model); no physical PDF E2E |
| Page processing failure | I empty/whitespace map parametrization; thrown page-provider exception through full-document SSE not established in inspected tests |
| Duplicate page | U `test_index_manifest.py::test_manifest_requires_every_physical_page_exactly_once`; duplicate DB-row runtime processor case GAP |
| Interruption halfway / worker resumes | I `test_document_extraction.py::test_resume_only_processes_pages_after_last_checkpoint` executes extraction with supplied previous context/pages31–60. Does not crash/restart a worker or load actual persisted checkpoint |
| Same request retried | W `test_scoped_worker_contract.py::test_resume_and_retry_endpoints_preserve_job_identity`; `test_resume_is_idempotent_while_worker_lease_is_valid`; actual repeated worker execution GAP |
| Revision changes mid-job | GAP; revision-sensitive hashes/stale-region checks are different scenarios |
| All questions section 10 / entire exam | U `test_scoped_extraction.py` and grounding grammar scope checks; full generated, persisted extraction compared to source inventory GAP |
| Truncated model batch/final | Confirmed baseline defect probe `audit/repros/test_full_document_truncation.py`; coordinator owns permanent regressions/fix. Consult final run state |

## Stream, auth, and chat lifecycle injections

| Requested scenario | Evidence |
|---|---|
| Before first token / after first token | I `ai-terminal-runtime.test.mjs` generated tests `failure before token is recoverable and the next request remains usable` and `failure after token is recoverable and the next request remains usable` |
| Malformed SSE / wrong request ID | I same file: `malformed and wrong-request frames cannot contaminate a valid answer` |
| Duplicated event / duplicate stream tokens | GAP for duplicate nonterminal token policy. Terminal trailing-event suppression is separately tested; parser framing does not prove token deduplication |
| Missing done / empty completed | I same file: `EOF without done is recoverable and the next request remains usable`, `empty completion is recoverable and the next request remains usable`; B `empty-completed` |
| Timeout | Semantic timeout covered; actual SSE inactivity timeout with next-prompt recovery GAP in inspected runtime tests |
| Stop / immediately next prompt | B `audit/repros/browser-chat.mjs`: `stop`, `stop-next`; fake SSE through actual UI |
| Change chats / old completion late | B `switch-before-submission` delays conversation setup; does not itself switch during active token delivery. I wrong-request frame rejection; active background completion full browser sequence GAP |
| Retry while old stream exists | GAP; browser `error-retry` runs after error, not concurrently alive stream |
| Retry after source selection changed | I `ai-request-scope-runtime.test.mjs`: `retry preserves original retrieval scope even when the previous resolution used fewer documents` |
| Regenerate old answer | W `ai-stream-recovery.test.mjs` regenerate/source checks; actual browser regenerate after selection change GAP |
| Reload after error/interruption | B `reload-interrupted`; successful answer and error-only reload sequences not independently established |
| Five requests expire / apparently-valid token rejected | U `authenticated-fetch.test.mjs`: `coalesces simultaneous refreshes`; I `auth-browser-adapter.test.mjs`: `five rejected-token requests with delayed 401s share one real refresh` |
| Refresh token revoked, storm stops | I real-adapter revoked case proves one call's no unauthenticated retry; five-feature background storm after revocation GAP |
| Temporary refresh network failure preserves valid session | GAP in inspected adapter tests |
| Offline to online | U/I `saved-reply-sync-engine.test.mjs`: `create offline -> reload -> online: a later flush retries and syncs without a user re-click`; not all feature transports |

## Model output injections

| Requested model output | Evidence |
|---|---|
| Timeout | I semantic gate timeout test |
| Empty response | I fast terminal and full-document failure tests |
| Malformed JSON / wrong enum / missing required structure | U `test_semantic_followup_gate.py::test_malformed_semantic_output_uses_safe_conversation_fallback` parametrizations include empty, broken JSON, bogus relation, wrong field types |
| Unexpected task family | GAP for separately injected unknown task family through endpoint; bogus relation is not the same field |
| Invalid action block | U `ai-actions-render.test.mjs`: `unknown action ids are dropped; all-unknown renders nothing`, `malformed JSON renders nothing and does not throw`, `a missing or empty label drops the button` |
| Broken ExamForge JSON | I `test_examforge.py::test_generate_examforge_replenishes_rejected_slots_with_verified_replacements` covers rejected generated items; raw syntactically broken provider JSON through full ExamForge path GAP |
| Duplicate stream tokens | GAP |
| Partial answer then exception | I native reader rejection; B `partial-disconnect`; these simulate transport, distinct from actual answer-provider throw after token |
| Invalid confidence (additional) | U `test_semantic_followup_gate.py::test_invalid_semantic_confidence_uses_safe_fallback`: NaN, infinity, boolean, out-of-range |

This matrix deliberately preserves gaps. Existing helper and source assertions are useful but cannot satisfy the original request's full boundary-injection acceptance gate on their own.

# Conversation investigation

Audited SHA: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`. Read-only production investigation; no live semantic-model or browser execution.

## Finding CONV-1

### Severity
P1

### User scenario
Receive a professor-grounded explanation, ask â€œthat went over my headâ€, then ask â€œare you sure?â€.

### Expected
Clarification reuses the grounded answer; verification inherits its course provenance and requests fresh course evidence.

### Actual
The clarification reaches FAST_CONTEXTUAL correctly, but its completion advertises `groundingMode=general`, `answerMode=general`, `sources=[]` and omits `sourceScope`. Feeding that real emitted metadata into the next dialogue resolution produces GENERAL_KNOWLEDGE.

### Evidence
Executed integration probe `audit/repros/test_conversation_full_document.py::test_grounded_reuse_emits_general_provenance` passes by asserting the defective behavior. It invokes the real ask-stream endpoint and consumes SSE; auth/subscription and answer generation are mocked. Original grounded history includes `sourceScope=course_files`; the emitted clarification does not. This is not browser persistence verification.

### Root cause
The execution lane used to paraphrase evidence also determines provenance. FAST_CONTEXTUAL shares the general stream implementation, which unconditionally labels the result general. Source identity is lost across a valid evidence-reuse operation.

### Files
`backend/python-ai/app/routers/stream.py`: `_prepare_ask_stream_response` fast general/contextual completion block around 1562â€“1640. `backend/python-ai/app/services/dialogue_state.py`: `_previous_answer_provenance`, `resolve_evidence_requirement`.

### Structural fix
Preserve the source provenance of reused evidence independently of the execution lane; make that provenance available in terminal metadata and subsequent turns. Coordinator owns implementation.

### Regression test
Permanent three-turn integration test: grounded answer -> paraphrase -> neutral verification. Assert the paraphrase performs no fresh retrieval, preserves course scope/provenance, and verification requires new course evidence. Add browser persistence/reload coverage separately.

### Related findings
Evidence routing report; repeated paraphrases and web-derived clarifications have the same provenance risk.

## Coverage and limits

Existing dialogue, conversational-evidence, execution-router, grounding-contract, source-router and full-document tests were executed: 161 existing tests passed, 6 skipped. The six semantic paraphrase generalization cases are explicitly skipped live-model tests. Study-plan confirmation, no-offer social replies, corrections and plan modifications have deterministic unit coverage in the existing suites; that does not prove unseen natural-language interpretation by a live classifier. General clarification, direct grounded clarification and explicit location requests have mocked-provider orchestration coverage. A topic change has unit routing coverage. No claim of all eight journeys passing in a live product is made.


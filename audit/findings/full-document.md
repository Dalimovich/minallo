# Full-document investigation

Audited SHA: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`.

## Finding FULL-1

### Severity
P1

### User scenario
Ask for a full PDF summary. An otherwise successful model response contains empty output for a map batch or final synthesis.

### Expected
A typed, retryable processing failure with no completeness claim; only successfully processed pages count as processed.

### Actual
With one real required manifest page and injected empty map/synthesis output, `process_full_documents` returns `answer=''` and `coverageResult.complete=True`. The stream caller accepts complete coverage, emits coverage-complete commentary, and emits a done event with that empty answer.

### Evidence
Executed real processor with mocked Supabase rows/model boundary: `audit/repros/test_conversation_full_document.py::test_full_document_empty_model_output_claims_complete`. The downstream empty done is deterministic code proof at stream.py around 2027–2047, not a separately consumed endpoint repro. Existing two full-document progress tests pass.

### Root cause
Coverage counts source row presence as processing success before any model batch runs. Neither `_call_openai` nor this processor validates usable model output; synthesis completion is unconditional. `_call_openai` also ignores finish_reason, so output truncation is not distinguished from completion (code inspection, not separately injected).

### Files
`backend/python-ai/app/services/full_document_processing.py`: `process_full_documents`, especially processed_ids and final result. `backend/python-ai/app/routers/notes_full.py`: `_call_openai`. `backend/python-ai/app/routers/stream.py`: exhaustive_document_stream.

### Structural fix
Separate indexed-page coverage from validated processing coverage and validate map/synthesis completion before declaring success. Coordinator owns implementation.

### Regression test
Inject empty map result, empty final result and truncated provider result independently. Assert no successful complete result, an appropriate retryable error, and page progress only for successful batches. Consume the actual full-document SSE branch as well as testing the processor.

### Related findings
Generic empty-completion lifecycle failures may share output validation needs, but full-document coverage accounting is independently incorrect.

## Scope and limits

The processor reads pages at the captured active revision and declines complete coverage when a required manifest page lacks a row. It does not call top-k retrieval. Page rows are collapsed by number; duplicate rows are not independently rejected here. Batch progress is runtime tested across two documents/five pages. One-page empty-output failure is executed. A 100-page live PDF, missing page 40 endpoint, mid-job revision changes, interruption/resume, repeated request, and worker restart were not exercised by this investigator. Extraction uses a separate scoped-extraction path; section 10 and entire-exam grammar are covered by existing grounding tests, not end-to-end extraction here. Do not infer exhaustive-content correctness or durable resume support from manifest/grammar unit tests.

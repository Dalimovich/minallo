# P0 complete-document extraction production-path audit

Date: 2026-07-26

Request traced: `I need all Kurzfragen in this exam answered and explained, all of them.`

## Authoritative deployed path

The production implementation is the SSE chatbot path. The ordinary `/ask` and
top-k answer services are not authoritative for this request.

```text
frontend/js/features/chatbot-new/shell.ts
  sendCurrentMessage / executeAssistantRequest
  -> appendAiBubble (durable assistant placeholder)
  -> streamAsk request

backend/python-ai/app/routers/stream.py
  ask_stream_endpoint (POST /ask-stream)
  -> _prepare_ask_stream_response
  -> question normalization + reference/dialogue resolution
  -> active/single selected document resolution
  -> classify_document_extraction
  -> durable extraction-cache lookup
  -> section/family structural discovery
  -> extract_document_qa
  -> pair_questions_and_solutions / recover_unanswered_answers
  -> extraction context + cache persistence
  -> build_learning_journey + format_document_extraction
  -> SSE meta/done event

backend/python-ai/app/services/scoped_extraction.py
  -> canonical ScopedRequestSpec
  -> immutable manifest validation/promotion
  -> stable scope-item identity and state machine
  -> finalise_scoped_job (sole authoritative completion calculation)

backend/python-ai/app/services/scoped_job_store.py
  -> revision-aware job/manifest lookup
  -> candidate, item checkpoint and stable-event persistence
  -> refresh/reconnect snapshots

frontend/js/features/chatbot-new/shell.ts
  streamAsk completion
  -> learningJourneyMarkerFromMeta
  -> isValidLearningJourney
  -> appendAskStreamMeta
  -> enhanceDocumentLearningJourney
  -> chat-store persistence / refresh restore
```

## Actual ownership by requirement

- Frontend send handler: the standalone chatbot send flow in
  `frontend/js/features/chatbot-new/shell.ts`, specifically the request path that
  creates an assistant record and invokes `executeAssistantRequest`/`streamAsk`.
- Assistant placeholder: `appendAiBubble` in `shell.ts`; durable message state is
  created immediately before the stream starts.
- API and stream endpoint: `ask_stream_endpoint` (`POST /ask-stream`) and deferred
  `_prepare_ask_stream_response` in `backend/python-ai/app/routers/stream.py`.
- Intent classification: `classify_document_extraction` in
  `backend/python-ai/app/services/document_extraction.py`. It currently requires
  both `_EXHAUSTIVE_RE` and `_EXTRACTION_RE`, then resolves `_TARGET_RE`.
- Document selection: `_prepare_ask_stream_response` resolves explicit names/IDs,
  promotes a sole selected document to `activeDocumentId`, verifies ownership,
  and rejects document-wide extraction unless exactly one active document exists.
- Scope resolution: `resolve_section_family` (unnumbered Kurzfragen family) or
  `resolve_document_section` (numbered target) in `document_extraction.py`.
- Relevance versus coverage selection: the branch immediately after
  `classify_document_extraction` in `_prepare_ask_stream_response`. When true it
  bypasses normal `retrieve_chunks`; otherwise `derive_grounding_state` and
  `retrieve_chunks` own focused relevance retrieval.
- Retrieval execution in coverage mode: `_load_document_pages` and
  `extract_document_qa`, which scan ordered stored pages in map batches. Semantic
  top-k is not intended to define this inventory.
- Question discovery: `extract_document_qa`; per-page parsing is performed by
  `_extract_page_structured`, `_extract_visual_page` and their merge/dedup logic.
- Section-family discovery: `resolve_section_family`; missing text headings fall
  back through `_discover_visual_section_headings`.
- Answer pairing: `pair_questions_and_solutions`.
- Answer recovery: `recover_unanswered_answers`, with `AnswerRecoveryRecord`.
- Conversation cache: `DocumentExtractionContext`, in-memory
  `_EXTRACTION_CONTEXTS`, serialized into durable `TutorState`.
- Document/revision cache: `load_verified_extraction_cache` and
  `promote_verified_extraction_cache` in `document_extraction_cache.py`, backed by
  `document_extraction_caches`.
- Cache replacement: `promote_verified_extraction_cache` calls `should_replace_cache`
  then performs an upsert on one document/revision/target row.
- Job persistence: `complete_document_jobs`, `request_scope_manifests`,
  `request_scope_items`, and `scope_job_events`, owned by
  `scoped_job_store.py`. Conversation state remains a compatibility layer, not
  the authoritative inventory.
- Stream progress: extraction checkpoints retain legacy conversation recovery;
  the scoped store additionally persists stable, idempotent `scope.*` events and
  per-item answer checkpoints. `/scoped-jobs/{job_id}` exposes the same
  authoritative state for refresh/reconnect.
- Final validation: booleans and page/item checks at the end of
  `extract_document_qa`; cache promotion adds a second quality gate.
- Learning Journey construction: `build_learning_journey`.
- Frontend validation: `learningJourneyMarkerFromMeta` and
  `isValidLearningJourney`.
- Frontend completion rendering: `enhanceDocumentLearningJourney`.

## Explicit failure answers

### Which function classifies “all Kurzfragen”?

`classify_document_extraction`.

### Which function chooses relevance versus coverage retrieval?

`_prepare_ask_stream_response`: its `document_extraction` branch is coverage;
the later `derive_grounding_state` + `retrieve_chunks` path is relevance.

### Which function owns section-family discovery?

`resolve_section_family`.

### Which function can return questions when `questionPagesTotal == 0`?

`build_learning_journey` can serialize `paired_items` independently of the
computed question-page set. The backend lacks a single hard invariant that raises
when items exist with zero resolved question pages. The frontend now rejects some
such journeys, but the invalid backend result can still exist and be persisted.

### Which code admits 12.* and 13.* into a Kurzfragen result?

The unsafe historical path is extraction/merge before strict family membership.
`item_belongs_to_requested_section` returns `True` for any unnumbered target, so
it cannot protect `all Kurzfragen`. Newer prefix filtering based on
`resolved_family.section_numbers` exists late in `extract_document_qa`, but no
persistent manifest membership invariant protects pairing, cache merge and every
future call site. If family discovery is absent or a cached payload is malformed,
12.* and 13.* are not rejected by the general helper.

### Which cache stores the previous complete inventory?

`document_extraction_caches.questions`, loaded by
`load_verified_extraction_cache`. A conversation-local copy also exists in
`TutorState.document_extraction_context`.

### Which code can overwrite that cache with a partial result?

The legacy `promote_verified_extraction_cache` still upserts its compatibility
row, but now rejects candidates that lose any existing exact ID. The authoritative
path writes candidates separately through `persist_manifest_candidate`, compares
exact same-revision IDs, sections and source pages, and atomically activates only
a verified candidate.

### Which function emits “Scope complete”?

`finalise_scoped_job` owns the authoritative booleans and counts. The frontend
renders “Question scope complete” only from `discoveryComplete` supplied by that
state; it does not derive completion from display counts.

### Which frontend code accepts and renders an invalid Learning Journey?

`isValidLearningJourney` now requires manifest sealing, discovery completion,
positive resolved pages, exact discovered/list parity, unique in-scope IDs,
consistent authoritative terminal counts, and zero rejected items. Invalid
payloads emit `invalid_journey_rejected`, show structural recovery, or reuse a
last-known-good verified journey.

### Which path is authoritative in production?

`POST /ask-stream` -> `_prepare_ask_stream_response` -> document-extraction branch
-> `extract_document_qa` -> `build_learning_journey` -> SSE metadata ->
`enhanceDocumentLearningJourney`.

## Implemented ownership after the audit

- Request interpretation: `classify_scoped_request`; it performs no retrieval.
- Focused relevance retrieval: `retrieval.retrieve_chunks`.
- Coverage discovery: `document_extraction.extract_document_qa`, with a strict
  `discovery_checkpoint` phase boundary before per-item answer recovery.
- Logical-unit indexing: `indexing._replace_logical_units`, additive to the
  existing page/chunk index and revision lifecycle.
- Manifest and job persistence: `scoped_job_store` and migration
  `20260726_000007_scoped_document_jobs.sql`.
- Candidate correctness: `validate_manifest`, `manifest_quality`, and
  `promote_manifest`, including exact same-revision ID/page containment.
- Item verification/checkpoints: `persist_item_state`.
- Retry policy: `recover_unanswered_answers` plus persisted per-item checkpoints.
- Authoritative finalisation: `finalise_scoped_job` only.
- Stream transport: `stream.py` consumes the job engine and emits its identifiers;
  it does not calculate independent completion state.
- Frontend rendering: `isValidLearningJourney` validates backend state and
  `reconcileScopedJourney` reloads it; it does not infer terminal status.

The audit remains a release artifact. Production scenario evidence and any
remaining blocked test-suite results belong in the final verification report,
not in this ownership map.

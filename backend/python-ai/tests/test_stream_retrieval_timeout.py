"""Regression for the 2026-10-21 production incident: a real request
(``ncb_msg_mvibafuc_mz2in7jf``, confirmed via server logs) spent 100+
unbounded seconds inside primary retrieval during a transient Supabase
slowdown, then got cancelled by something unrelated to retrieval itself
with no error ever shown to the student (the stream closed with
``terminal_event_sent=False``). ``app/routers/stream.py``'s retrieval
awaits are now wrapped in ``_await_bounded`` (``_RETRIEVAL_TIMEOUT_
SECONDS``), so a genuine stall now fails fast with an honest, retryable
error instead of hanging until something else notices.

Design: exercises the REAL /ask-stream route and REAL retrieval gather
(not a stubbed-out `_prepare_ask_stream_response`) -- only one retrieval
function is made artificially slow (synchronous `time.sleep`, matching
how a real blocking Supabase call behaves inside `run_in_threadpool`),
and the timeout constant is shrunk so this test doesn't need to wait out
the real production bound.
"""

from __future__ import annotations

import asyncio
import time
import uuid

import tests.test_live_eval_remediation_acceptance as base
from app.services import retrieval


def test_a_genuinely_stuck_retrieval_fails_fast_with_a_retryable_error(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    monkeypatch.setattr(stream, "_RETRIEVAL_TIMEOUT_SECONDS", 0.2)

    doc_id = str(uuid.uuid4())
    chunk = retrieval.RetrievedChunk(
        chunk_id="c-1", document_id=doc_id, page_start=1, page_end=1,
        text="Some course content.", score=1.0, similarity=1.0,
        chunk_type="notes", section_title=None,
    )

    def _stuck_retrieve_routed_chunks(**_kw):
        time.sleep(2.0)  # far longer than the 0.2s timeout above
        return [chunk]

    monkeypatch.setattr(stream, "retrieve_routed_chunks", _stuck_retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", _stuck_retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **kw: [chunk])
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **kw: type("R", (), {"chunks": [chunk], "evidence": [], "to_dict": lambda self: {}})(),
    )
    monkeypatch.setattr(stream, "_load_authorized_documents", lambda *_: {
        doc_id: {
            "id": doc_id, "user_id": base.USER_ID, "course_id": "course-1",
            "file_name": "notes.pdf", "storage_path": "synthetic/notes.pdf",
            "document_hash": "rev-1", "processing_status": "ready",
            "page_count": 1, "chunk_count": 1,
        },
    })
    base._install_capturing_transport(monkeypatch, intent_response_json=None, draft_text="n/a")

    async def run():
        payload = stream.AskStreamRequest(
            courseId="course-1", activeDocumentId=doc_id, question="explain this to me",
            sourceMode="course_files", conversationId="retrieval-timeout-test",
            conversationGeneration=1, previousTurns=[],
            visiblePage=1, openFileContext="Some course content.",
        )
        response = await stream.ask_stream_endpoint(payload, {"id": base.USER_ID})
        return b"".join([event async for event in response.body_iterator])

    started = time.perf_counter()
    try:
        body = asyncio.run(asyncio.wait_for(run(), timeout=15.0))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    elapsed = time.perf_counter() - started

    assert elapsed < 5.0, (
        f"a stuck retrieval must fail fast (bounded by the shrunk 0.2s timeout), "
        f"not hang for the full 2s the mock sleeps: {elapsed:.2f}s"
    )
    assert b'"code": "retrieval_timed_out"' in body, (
        f"a genuine retrieval stall must produce an honest, retryable error, "
        f"never a silent hang: {body!r}"
    )
    assert b'"retryable": true' in body

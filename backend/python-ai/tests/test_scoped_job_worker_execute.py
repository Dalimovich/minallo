"""Behavioral tests for scoped_job_worker._execute's preflight construction.

Regression coverage for a real production incident (job 58007d41-...,
2026-09-01): _execute() built a preflight dict missing execution_plan/
grounding_request/grounding_resolution, so every scoped (exhaustive/coverage)
job crashed with AttributeError: 'NoneType' object has no attribute
'executionLane' inside _prepare_ask_stream_response. No network, no DB.
"""

from __future__ import annotations

import json

import pytest


def _job(*, request_payload: dict) -> dict:
    return {
        "id": "58007d41-a3a6-45c8-bacb-4f897995b8a7",
        "user_id": "b1f54590-3be9-4ef7-8235-f877befaccb3",
        "course_id": "uc_1776947657158",
        "document_ids": ["0500fef3-cc0a-448c-ab4a-ee002fcd46b6"],
        "request_id": "req-1",
        "request_payload": request_payload,
    }


def _valid_snapshot() -> dict:
    return {
        "groundingRequest": {
            "retrievalScope": {
                "type": "documents",
                "documentIds": ["0500fef3-cc0a-448c-ab4a-ee002fcd46b6"],
            },
            "viewerContext": {
                "documentId": "0500fef3-cc0a-448c-ab4a-ee002fcd46b6",
                "revision": None,
                "visiblePage": 1,
            },
        },
        "groundingResolution": {
            "documentIds": ["0500fef3-cc0a-448c-ab4a-ee002fcd46b6"],
            "documentRevisions": {"0500fef3-cc0a-448c-ab4a-ee002fcd46b6": "rev1"},
            "documentAccess": "relevance",
            "resolutionReason": "relevance_default",
            "processingPipeline": "relevance",
        },
    }


def _sse(payload: dict) -> bytes:
    return ("data: " + json.dumps(payload) + "\n\n").encode("utf-8")


class _FakeResponse:
    async def _empty_iter(self):
        return
        yield  # pragma: no cover - makes this an async generator

    def __init__(self) -> None:
        self.body_iterator = self._empty_iter()


class _StreamingFakeResponse:
    """Mimics _prepare_ask_stream_response's real SSE output for a plain
    (non-exhaustive) answer - a StreamingResponse never calls persist_scoped_result
    itself for this lane, unlike the document-wide-extraction lane."""

    def __init__(self, events: list[dict]) -> None:
        self._events = events
        self.body_iterator = self._iter()

    async def _iter(self):
        for event in self._events:
            yield _sse(event)


class _FakeTable:
    def __init__(self, name: str, on_execute) -> None:
        self._name = name
        self._on_execute = on_execute
        self._fields: dict = {}

    def update(self, fields: dict) -> "_FakeTable":
        self._fields = fields
        return self

    def eq(self, *_a, **_k) -> "_FakeTable":
        return self

    def execute(self):
        self._on_execute(self._name, self._fields)
        return None


class _FakeSupabase:
    def __init__(self, on_execute) -> None:
        self._on_execute = on_execute

    def table(self, name: str) -> _FakeTable:
        return _FakeTable(name, self._on_execute)


@pytest.mark.asyncio
async def test_execute_populates_execution_plan_and_grounding_in_preflight(monkeypatch) -> None:
    from app.services import scoped_job_worker
    from app.routers import stream as stream_router

    captured: dict = {}

    monkeypatch.setattr(stream_router, "_load_authorized_documents", lambda *a, **k: {})

    async def fake_prepare(payload, user, status_sink, request_id, preflight):
        captured["preflight"] = preflight
        return _FakeResponse()

    monkeypatch.setattr(stream_router, "_prepare_ask_stream_response", fake_prepare)
    monkeypatch.setattr(
        scoped_job_worker, "load_job_snapshot", lambda **k: None,
    )

    job = _job(request_payload={
        "courseId": "uc_1776947657158",
        "question": "are there any exams at all in any of the courses I have uploaded?",
        "requestSnapshot": _valid_snapshot(),
    })

    await scoped_job_worker._execute(job)

    preflight = captured["preflight"]
    assert preflight["execution_plan"] is not None
    assert preflight["execution_plan"].executionLane is not None
    assert preflight["grounding_request"].retrievalScope.type == "documents"
    assert preflight["grounding_resolution"].processingPipeline == "relevance"


@pytest.mark.asyncio
async def test_execute_fails_clearly_when_snapshot_is_missing(monkeypatch) -> None:
    from app.services import scoped_job_worker
    from app.routers import stream as stream_router

    monkeypatch.setattr(stream_router, "_load_authorized_documents", lambda *a, **k: {})

    job = _job(request_payload={
        "courseId": "uc_1776947657158",
        "question": "are there any exams?",
    })

    with pytest.raises(RuntimeError, match="groundingRequest/groundingResolution"):
        await scoped_job_worker._execute(job)


@pytest.mark.asyncio
async def test_execute_bridges_fast_path_answer_into_job_and_tutor_request(monkeypatch) -> None:
    """Regression test: a scoped/coverage job whose execution_plan resolves
    to a plain (non-exhaustive) answer - e.g. "are there any exams at all in
    any of the courses I have uploaded?", which only needs a normal relevance
    lookup, not per-page extraction - used to leave the job's finalText/
    processingFinished unset forever, since only the document-wide-extraction
    lane calls persist_scoped_result. Both the browser's own live poller and
    this worker's completion sync key off exactly those two fields, so the
    request looked permanently stuck even though a correct answer was
    generated. Confirmed against the real production job
    58007d41-a3a6-45c8-bacb-4f897995b8a7 after the AttributeError fix landed.
    """
    from app.services import scoped_job_worker, conversation_store
    from app.routers import stream as stream_router

    monkeypatch.setattr(stream_router, "_load_authorized_documents", lambda *a, **k: {})

    events = [
        {"meta": True, "requestId": "req-1"},
        {"status": "reading_question"},
        {"t": "There are "},
        {"t": "no exams uploaded."},
        {"done": True, "sources": [{"file_name": "formelzettel.pdf"}]},
    ]

    async def fake_prepare(payload, user, status_sink, request_id, preflight):
        return _StreamingFakeResponse(events)

    monkeypatch.setattr(stream_router, "_prepare_ask_stream_response", fake_prepare)

    job_state = {"status": "structural_indexing", "finalText": None, "processingFinished": False}

    def fake_load_job_snapshot(**_k):
        return dict(job_state)

    def fake_persist_scoped_result(*, job_id, final_text, learning_journey, sources, answer_mode):
        job_state["finalText"] = final_text
        job_state["sources"] = sources
        job_state["answerMode"] = answer_mode

    def on_execute(table_name, fields):
        if table_name == "complete_document_jobs" and fields.get("status") == "processing_finished":
            job_state["status"] = "processing_finished"
            job_state["processingFinished"] = True

    monkeypatch.setattr(scoped_job_worker, "load_job_snapshot", fake_load_job_snapshot)
    monkeypatch.setattr(scoped_job_worker, "persist_scoped_result", fake_persist_scoped_result)
    monkeypatch.setattr(scoped_job_worker, "get_supabase", lambda: _FakeSupabase(on_execute))

    completed: dict = {}
    monkeypatch.setattr(
        conversation_store, "update_tutor_request",
        lambda **kwargs: completed.update(kwargs),
    )

    job = _job(request_payload={
        "courseId": "uc_1776947657158",
        "question": "are there any exams at all in any of the courses I have uploaded?",
        "requestSnapshot": _valid_snapshot(),
    })

    await scoped_job_worker._execute(job)

    assert job_state["status"] == "processing_finished"
    assert job_state["finalText"] == "There are no exams uploaded."
    assert completed["status"] == "completed"
    assert completed["final_answer"] == "There are no exams uploaded."


@pytest.mark.asyncio
async def test_execute_syncs_inline_sse_error_as_job_and_request_failure(monkeypatch) -> None:
    """An error event yielded mid-stream (not a raised Python exception) must
    still fail the job and the durable tutor request - otherwise it's the
    same "stuck forever" symptom as the missing-completion-sync bug above,
    just triggered by a graceful in-stream error instead of a crash."""
    from app.services import scoped_job_worker, conversation_store
    from app.routers import stream as stream_router

    monkeypatch.setattr(stream_router, "_load_authorized_documents", lambda *a, **k: {})

    events = [
        {"meta": True, "requestId": "req-1"},
        {"type": "error", "error": True, "code": "document_access_revoked",
         "message": "Document access changed during this request."},
    ]

    async def fake_prepare(payload, user, status_sink, request_id, preflight):
        return _StreamingFakeResponse(events)

    monkeypatch.setattr(stream_router, "_prepare_ask_stream_response", fake_prepare)

    job_state = {"status": "structural_indexing", "finalText": None, "processingFinished": False}

    def fake_load_job_snapshot(**_k):
        return dict(job_state)

    def on_execute(table_name, fields):
        if table_name == "complete_document_jobs" and fields.get("status") == "failed_recoverable":
            job_state.update({
                "status": "failed_recoverable",
                "failureCode": fields.get("failure_code"),
                "failureMessage": fields.get("failure_message"),
            })

    monkeypatch.setattr(scoped_job_worker, "load_job_snapshot", fake_load_job_snapshot)
    monkeypatch.setattr(scoped_job_worker, "get_supabase", lambda: _FakeSupabase(on_execute))

    completed: dict = {}
    monkeypatch.setattr(
        conversation_store, "update_tutor_request",
        lambda **kwargs: completed.update(kwargs),
    )

    job = _job(request_payload={
        "courseId": "uc_1776947657158",
        "question": "generate an exam similar to what my professor did but different values",
        "requestSnapshot": _valid_snapshot(),
    })

    await scoped_job_worker._execute(job)

    assert job_state["status"] == "failed_recoverable"
    assert job_state["failureCode"] == "document_access_revoked"
    assert completed["status"] == "failed"
    assert completed["error_code"] == "document_access_revoked"

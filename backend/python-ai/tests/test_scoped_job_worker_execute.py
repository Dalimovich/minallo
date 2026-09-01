"""Behavioral tests for scoped_job_worker._execute's preflight construction.

Regression coverage for a real production incident (job 58007d41-...,
2026-09-01): _execute() built a preflight dict missing execution_plan/
grounding_request/grounding_resolution, so every scoped (exhaustive/coverage)
job crashed with AttributeError: 'NoneType' object has no attribute
'executionLane' inside _prepare_ask_stream_response. No network, no DB.
"""

from __future__ import annotations

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


class _FakeResponse:
    async def _empty_iter(self):
        return
        yield  # pragma: no cover - makes this an async generator

    def __init__(self) -> None:
        self.body_iterator = self._empty_iter()


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

"""Unit tests for small /ask-stream routing helpers."""

from __future__ import annotations

import asyncio
import time


def test_open_context_augments_deictic_retrieval_query() -> None:
    from app.routers.stream import _augment_retrieval_query_with_open_context

    out = _augment_retrieval_query_with_open_context(
        question="solve this",
        retrieval_query="solve this",
        open_file_context="Aufgabe 9.1 Nachgiebigkeit Schraube Flanschteile",
        has_problem_solver=False,
    )

    assert "solve this" in out
    assert "Nachgiebigkeit Schraube" in out


def test_open_context_does_not_augment_specific_broad_query() -> None:
    from app.routers.stream import _augment_retrieval_query_with_open_context

    out = _augment_retrieval_query_with_open_context(
        question="Explain the full chapter about thermodynamics and entropy with all definitions",
        retrieval_query="Explain the full chapter about thermodynamics and entropy with all definitions",
        open_file_context="Unrelated visible exercise",
        has_problem_solver=False,
    )

    assert "Unrelated visible exercise" not in out


def test_cached_grounded_sources_keep_pages_string() -> None:
    from app.routers.stream import _cached_grounded_sources_to_js

    out = _cached_grounded_sources_to_js([
        {
            "fileName": "AG_9.1.pdf",
            "pages": "currently visible",
            "sectionTitle": "Open PDF",
        },
        {
            "fileName": "Lecture.pdf",
            "pageStart": 8,
            "pageEnd": 10,
            "sectionTitle": "Schraubenberechnung",
        },
    ])

    # The helper also carries documentId/pageStart/index through so the frontend
    # can open the cited PDF by id (robust against mangled file names) at the
    # right page. They're None here because the inputs don't supply them.
    assert out == [
        {"file_name": "AG_9.1.pdf", "pages": "currently visible", "section": "Open PDF",
         "documentId": None, "pageStart": None, "index": None},
        {"file_name": "Lecture.pdf", "pages": "8-10", "section": "Schraubenberechnung",
         "documentId": None, "pageStart": 8, "index": None},
    ]


def test_retrieval_limit_is_adaptive_for_direct_questions() -> None:
    from app.routers.stream import _retrieval_limit

    assert _retrieval_limit("Explain Aufgabe 13.1", 1) == 8
    assert _retrieval_limit("Where is this theorem used?", 3) == 10
    assert _retrieval_limit("What is cutting speed?", 7) == 12


def test_retrieval_limit_preserves_broad_coverage() -> None:
    from app.routers.stream import _retrieval_limit

    assert _retrieval_limit("Summarize the entire course", 1) == 18
    assert _retrieval_limit("Create an exam", 9, generative=True) == 27


def test_critical_unverified_draft_is_rejected_and_not_cacheable() -> None:
    from app.routers.stream import (
        _verification_is_cacheable,
        _verification_requires_rejection,
    )

    bad = {
        "status": "missing_context",
        "details": {"criticalNumericalMismatch": True},
    }
    assert _verification_requires_rejection(bad)
    assert not _verification_is_cacheable(bad)

    good = {
        "status": "verified",
        "details": {
            "criticalNumericalMismatch": False,
            "fabricatedFilenames": [],
            "invalidSourceIndices": [],
            "fakeSolutionPhrases": [],
        },
    }
    assert not _verification_requires_rejection(good)
    assert _verification_is_cacheable(good)


def test_unsupported_numeric_claim_is_rejected() -> None:
    from app.routers.stream import _verification_requires_rejection

    assert _verification_requires_rejection({
        "status": "partially_verified",
        "details": {"numberMisses": ["580"]},
    })


def test_structured_risk_buffering_covers_short_multilingual_and_formula_requests() -> None:
    from app.routers.stream import _requires_verified_buffering

    for question, act in [
        ("What is x?", "new_question"),
        ("Find vc.", "new_question"),
        ("Et b ?", "continue_next_question"),
        ("استخدم 560", "correct_assistant"),
        ("x = 560/2", "new_question"),
    ]:
        assert _requires_verified_buffering(
            question=question,
            dialogue_act=act,
            has_visual_evidence=False,
            has_active_numerical_state=False,
        )


def test_selection_from_old_page_or_revision_is_stale() -> None:
    from app.routers.stream import SelectedRegionPayload, _selection_is_stale

    region = SelectedRegionPayload(
        page=3, x=0.1, y=0.2, width=0.3, height=0.1,
        documentRevision="doc:rev-1",
    )
    assert not _selection_is_stale(
        region, visible_page=3, viewer_revision="doc:rev-1",
    )
    assert _selection_is_stale(
        region, visible_page=4, viewer_revision="doc:rev-1",
    )
    assert _selection_is_stale(
        region, visible_page=3, viewer_revision="doc:rev-2",
    )


def test_stream_opens_before_deferred_pipeline(monkeypatch) -> None:
    from app.routers import stream as stream_router

    monkeypatch.setattr(stream_router, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_rate_limit", lambda *_: None)

    async def slow_prepare(*_args, **_kwargs):
        await asyncio.sleep(0.25)
        raise RuntimeError("test should not wait for deferred preparation")

    monkeypatch.setattr(stream_router, "_prepare_ask_stream_response", slow_prepare)

    async def run_check():
        payload = stream_router.AskStreamRequest(courseId="course", question="Explain this")
        started = time.perf_counter()
        response = await stream_router.ask_stream_endpoint(payload, {"id": "user"})
        returned_ms = (time.perf_counter() - started) * 1000
        first = await response.body_iterator.__anext__()
        await response.body_iterator.aclose()
        return returned_ms, first

    returned_ms, first = asyncio.run(run_check())
    assert returned_ms < 200
    assert b'"status": "reading_question"' in first

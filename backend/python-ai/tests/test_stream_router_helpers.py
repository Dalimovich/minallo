"""Unit tests for small /ask-stream routing helpers."""

from __future__ import annotations

import asyncio
import json
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


def test_number_misses_are_advisory_not_fatal() -> None:
    from app.routers.stream import verification_rejection

    result = verification_rejection({
        "status": "partially_verified",
        "details": {
            "numberMisses": ["6", "7", "8", "9"],
            "criticalNumericalMismatch": False,
        },
    }, task_type="visual_assignment")
    assert not result.reject
    assert result.reasons == ("unverified_numbers_advisory",)


def test_actual_copied_given_conflict_still_rejects() -> None:
    from app.routers.stream import verification_rejection

    result = verification_rejection({
        "details": {
            "numberMisses": [],
            "criticalNumericalMismatch": True,
        },
    }, task_type="numerical_problem")
    assert result.reject
    assert result.code == "critical_numerical_mismatch"


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
        response = await stream_router.ask_stream_endpoint(
            payload, {"id": "user"}, "client-request-1234"
        )
        returned_ms = (time.perf_counter() - started) * 1000
        first = await response.body_iterator.__anext__()
        second = await response.body_iterator.__anext__()
        await response.body_iterator.aclose()
        return returned_ms, first, second

    returned_ms, first, second = asyncio.run(run_check())
    assert returned_ms < 200
    assert b'"meta": true' in first
    assert b'"requestId": "client-request-1234"' in first
    assert b'"streamProtocolVersion": 2' in first
    assert b'"status": "reading_question"' in second


def test_inner_stream_silence_emits_keepalive(monkeypatch) -> None:
    from fastapi.responses import StreamingResponse
    from app.routers import stream as stream_router

    monkeypatch.setattr(stream_router, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream_router, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(stream_router, "_INNER_STREAM_HEARTBEAT_SECONDS", 0.01)

    async def slow_body():
        await asyncio.sleep(0.035)
        yield b'data: {"t": "Answer after keepalive"}\n\n'
        yield b'data: {"done": true}\n\n'

    async def prepare(*_args, **_kwargs):
        return StreamingResponse(slow_body(), media_type="text/event-stream")

    monkeypatch.setattr(stream_router, "_prepare_ask_stream_response", prepare)

    async def consume():
        payload = stream_router.AskStreamRequest(courseId="course", question="Explain")
        response = await stream_router.ask_stream_endpoint(payload, {"id": "user"})
        return [event async for event in response.body_iterator]

    events = asyncio.run(consume())
    statuses = [event for event in events if b'"status": "reading_question"' in event]
    assert len(statuses) >= 2
    assert sum(b'"done": true' in event for event in events) == 1


def test_evidence_unavailable_refusal_overwrites_the_stale_success_provenance() -> None:
    # QA V8 (2026-10-13): a declined draft (task/evidence identity mismatch)
    # kept whatever sourceScope/sourceLabel/sources the SOURCE DECISION had
    # already set earlier in the request — e.g. "course_files" / a 2-item
    # citation list — so the frontend badge (driven purely by sourceScope,
    # setBubbleSubtitle in shell.ts) showed success ("Using: Course files")
    # over a response the backend itself had just refused to give.
    from app.routers.stream import _mark_evidence_unavailable_refusal

    evt = {
        "sourceScope": "course_files",
        "sourceLabel": "Using: Course files",
        "sources": [{"page": 1}, {"page": 2}],
        "model": "gpt-4o",  # unrelated fields must survive untouched
    }

    _mark_evidence_unavailable_refusal(evt)

    assert evt["confidence"] == "low"
    assert evt["unsupported"] is True
    assert evt["sourceScope"] == "unavailable"
    assert evt["sourceLabel"] is None
    assert evt["sources"] == []
    assert evt["model"] == "gpt-4o"


def test_internet_mode_web_search_failure_is_disclosed_not_badged_as_success() -> None:
    # QA V11: explicit Internet mode whose web search genuinely failed
    # (stream_web_answer falling back to INTERNET_UNAVAILABLE_MESSAGE) still
    # carried the optimistic pre-stream "Using: Internet" / confidence=high
    # badge on the final done event, because _stream_live_answer's confidence/
    # unsupported were fixed before the stream ran and never reconsidered
    # once stream_web_answer signalled webSearchFailed=True.
    from app.routers.stream import _stream_live_answer
    from app.services.source_router import CourseFileScope, SourceDecision, SourceMode, SourceScope

    decision = SourceDecision(
        selected_source_mode=SourceMode.INTERNET,
        source_scope=SourceScope.INTERNET,
        course_file_scope=CourseFileScope.ALL_COURSE_FILES,
        source_label="Using: Internet",
    )

    def failed_web_search():
        yield {"t": "Internet search is temporarily unavailable."}
        yield {"done": True, "webSources": [], "model": None, "promptTokens": None,
               "completionTokens": None, "webSearchFailed": True}

    response = _stream_live_answer(
        events=failed_web_search(),
        decision=decision,
        answer_mode="internet",
        request_id="req-1",
        decision_for_done=lambda final: decision,
        map_sources=lambda final: [],
    )

    async def consume():
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(consume())
    done = next(json.loads(c.decode()[len("data: "):]) for c in chunks if b'"done": true' in c)
    assert done["confidence"] == "low"
    assert done["unsupported"] is True
    assert done["sourceScope"] == "unavailable"
    assert done["sourceLabel"] is None
    assert done["sources"] == []


def test_internet_mode_successful_web_search_keeps_its_badge() -> None:
    # Guards against over-correcting: a real web answer must NOT be downgraded
    # just because it happens to carry no parsed webSources.
    from app.routers.stream import _stream_live_answer
    from app.services.source_router import CourseFileScope, SourceDecision, SourceMode, SourceScope

    decision = SourceDecision(
        selected_source_mode=SourceMode.INTERNET,
        source_scope=SourceScope.INTERNET,
        course_file_scope=CourseFileScope.ALL_COURSE_FILES,
        source_label="Using: Internet",
    )

    def real_web_search():
        yield {"t": "Torsion is a twisting deformation under torque."}
        yield {"done": True, "webSources": [], "model": "gpt-4o", "promptTokens": 10, "completionTokens": 20}

    response = _stream_live_answer(
        events=real_web_search(),
        decision=decision,
        answer_mode="internet",
        request_id="req-2",
        decision_for_done=lambda final: decision,
        map_sources=lambda final: [],
    )

    async def consume():
        return [chunk async for chunk in response.body_iterator]

    chunks = asyncio.run(consume())
    done = next(json.loads(c.decode()[len("data: "):]) for c in chunks if b'"done": true' in c)
    assert done["confidence"] == "high"
    assert done["unsupported"] is False
    assert done["sourceScope"] == "internet"
    assert done["sourceLabel"] == "Using: Internet"


# ── V8 completion (release-readiness audit, 2026-10-14) ───────────────────
# Original V8 fix only corrected the BADGE on a declined answer. This closes
# the deeper gap: a just-uploaded, still-indexing document has no real
# retrieved chunks yet, so the identity-mismatch guard's "grounded identity"
# is built from nothing — it can false-positive against a draft that was
# actually correctly grounded in the VISIBLE PAGE. The guard must now defer
# to the draft when real page evidence was available, but still reject when
# it wasn't (honest limitation) or when the document is fully indexed (the
# mismatch is then real and must still be caught — see IMG08).

def test_identity_guard_defers_to_page_evidence_only_when_both_conditions_hold() -> None:
    from app.routers.stream import _identity_guard_should_defer_to_page_evidence

    # Indexing pending + a rendered page image → defer (trust the draft).
    assert _identity_guard_should_defer_to_page_evidence(
        active_document_indexing_pending=True,
        open_file_images=[{"mediaType": "image/png", "data": "x"}],
        open_file_context=None,
    )
    # Indexing pending + real visible-page TEXT (no image) → defer.
    assert _identity_guard_should_defer_to_page_evidence(
        active_document_indexing_pending=True,
        open_file_images=None,
        open_file_context="Preis=80, variable Stueckkosten=50, Fixkosten=300",
    )
    # Indexing pending but NO page evidence at all → do not defer (honest
    # limitation is the correct outcome, not trusting an ungrounded draft).
    assert not _identity_guard_should_defer_to_page_evidence(
        active_document_indexing_pending=True,
        open_file_images=None,
        open_file_context="   ",
    )
    # Document fully indexed (not pending) even with page evidence present →
    # do not defer; a real mismatch on an indexed document must still be
    # caught (this is the guard's actual fabrication-detection job).
    assert not _identity_guard_should_defer_to_page_evidence(
        active_document_indexing_pending=False,
        open_file_images=[{"mediaType": "image/png", "data": "x"}],
        open_file_context=None,
    )


# QA plan J2 ("explain page 11"): the named page overrides whatever the
# viewer reports as currently open, but only when a single document is
# already identified to resolve it against.

def test_explicit_page_lookup_overrides_the_viewers_reported_page() -> None:
    from app.routers.stream import _resolve_explicit_page_lookup

    page, clarification = _resolve_explicit_page_lookup(
        active_document_id="doc-1", visible_page=1, question="Explain page 11.",
    )
    assert page == 11
    assert clarification is None


def test_explicit_page_lookup_falls_back_to_viewer_page_without_a_named_page() -> None:
    from app.routers.stream import _resolve_explicit_page_lookup

    page, clarification = _resolve_explicit_page_lookup(
        active_document_id="doc-1", visible_page=5, question="Explain this diagram.",
    )
    assert page == 5
    assert clarification is None


def test_explicit_page_lookup_asks_instead_of_guessing_without_a_document() -> None:
    from app.routers.stream import _resolve_explicit_page_lookup

    page, clarification = _resolve_explicit_page_lookup(
        active_document_id=None, visible_page=None, question="Explain page 11.",
    )
    assert page is None
    assert clarification is not None
    assert "page 11" in clarification


def test_pending_index_page_evidence_provenance_is_honest_not_a_success_badge() -> None:
    from app.routers.stream import _mark_pending_index_page_evidence_provenance

    evt = {
        "sourceScope": "course_files",
        "sourceLabel": "Using: Course files",
        "sources": [{"page": 1}, {"page": 2}],
        "confidence": "high",
    }
    _mark_pending_index_page_evidence_provenance(evt)
    assert evt["indexingPending"] is True
    # "active_document" is the existing, frontend-recognised sourceScope for
    # "answered from the open document" (setBubbleSubtitle in shell.ts) — it
    # must not claim "course_files" (implies the full document was indexed).
    assert evt["sourceScope"] == "active_document"
    assert "indexing" in evt["sourceLabel"].lower()
    # Unrelated fields (confidence, prior sources list) are left untouched —
    # this only corrects provenance, it doesn't re-run _mark_evidence_unavailable_refusal.
    assert evt["confidence"] == "high"
    assert evt["sources"] == [{"page": 1}, {"page": 2}]

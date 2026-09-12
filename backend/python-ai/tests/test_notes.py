"""Unit tests for notes generation (notes.py)."""

from __future__ import annotations

import os
from dataclasses import dataclass

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")
os.environ.setdefault("INTERNAL_SECRET", "stub")

from app.services import notes  # noqa: E402
from app.services.grounding_contract import ResolvedDocumentAccess, resolve_document_access  # noqa: E402


def test_system_prompt_requires_strict_math_formatting_everywhere():
    # Regression coverage: this rule used to be the bare one-liner "4. Math
    # in KaTeX." with no elaboration, no prohibition on bare Unicode Greek
    # letters, and no example — which is exactly the shape the model failed
    # to follow in production (formulas like "deltaS = 2.4 x 10^-6" showing
    # up with no $ delimiters at all). Must now match the same strict,
    # example-driven rule already proven in flashcards.py/deep_learn.py.
    sys = notes._system_prompt("medium-length")
    assert "Math formatting is STRICT" in sys
    assert "not just Formula/Theorem" in sys  # applies to every section, not just formula cards
    assert "NEVER write a bare LaTeX command" in sys
    assert "NOT raw Unicode glyphs" in sys
    assert "$\\delta_S = 2.4 \\times 10^{-6}$" in sys
    assert "δS = 2.4 x 10^-6" in sys  # the exact bad-example shape, spelled out


# ── Whole-document summaries must route through exhaustive processing ──────
# "Summarize the whole document/every page/complete script" promises full
# coverage — a claim the ordinary top_k=40 relevance retrieval below cannot
# back for a long document. It must route through the same coverage-verified
# pipeline /ask-stream already uses, not silently answer from "the 40 most
# relevant chunks" while implying completeness.

@dataclass
class _FakePage:
    page_number: int
    required_for_processing: bool = True


def test_whole_document_phrasing_resolves_to_full_document_access():
    # This is the exact detector notes.py now reuses (grounding_contract.py) —
    # confirming it fires for realistic phrasing before testing the routing.
    for phrase in [
        "Summarize the entire document.",
        "Please summarize the complete script.",
        "summarize every page",
        "Fasse das gesamte Skript zusammen.",
    ]:
        access, _ = resolve_document_access(question=phrase, requested=None, viewer_context=None)
        assert access is ResolvedDocumentAccess.FULL_DOCUMENT, phrase


def test_ordinary_topic_summary_does_not_trigger_full_document_routing():
    access, _ = resolve_document_access(
        question="Summarize the main concepts about Newton's laws", requested=None, viewer_context=None,
    )
    assert access is ResolvedDocumentAccess.RELEVANCE


def test_whole_document_request_without_selected_documents_asks_to_select_them_rather_than_downgrading(monkeypatch):
    called = {"broad_rag": False}
    monkeypatch.setattr(notes, "retrieve_chunks", lambda **_: called.__setitem__("broad_rag", True) or [])

    out = notes.generate_notes(
        user_id="u1", course_id="c1", document_ids=None,
        topic="Please summarize the entire document.", doc_names={},
    )

    assert out["text"] == ""
    assert "select" in out["warning"].lower()
    assert called["broad_rag"] is False  # never silently fell back to broad RAG


def test_whole_document_request_with_too_many_documents_is_refused_with_a_clear_limit(monkeypatch):
    settings = notes.get_settings()
    too_many = [f"doc-{i}" for i in range(settings.full_document_max_documents + 1)]

    out = notes.generate_notes(
        user_id="u1", course_id="c1", document_ids=too_many,
        topic="Summarize the whole document.", doc_names={},
    )

    assert out["text"] == ""
    assert str(settings.full_document_max_documents) in out["warning"]


def test_whole_document_request_with_complete_coverage_returns_the_exhaustive_answer(monkeypatch):
    from app.routers import stream as stream_router

    monkeypatch.setattr(
        stream_router, "_load_authorized_documents",
        lambda user_id, course_id, ids: {ids[0]: {"id": ids[0], "file_name": "Lecture.pdf", "active_index_revision": "r1", "page_count": 2}},
    )
    monkeypatch.setattr(stream_router, "_load_canonical_manifest", lambda row: [_FakePage(1), _FakePage(2)])
    monkeypatch.setattr(
        notes, "process_full_documents",
        lambda **kwargs: {
            "answer": "Complete exhaustive summary of every page.",
            "coverageResult": {"complete": True, "documents": []},
            "sources": [{"fileName": "Lecture.pdf", "pageStart": 1, "pageEnd": 2}],
        },
    )

    out = notes.generate_notes(
        user_id="u1", course_id="c1", document_ids=["doc-1"],
        topic="Summarize the entire document.", doc_names={"doc-1": "Lecture.pdf"},
    )

    assert out["text"] == "Complete exhaustive summary of every page."
    assert out["fullDocumentCoverage"] is True
    assert out["groundedSources"][0]["documentId"] == "doc-1"


def test_whole_document_request_with_incomplete_coverage_refuses_rather_than_returning_a_partial_summary(monkeypatch):
    from app.routers import stream as stream_router

    monkeypatch.setattr(
        stream_router, "_load_authorized_documents",
        lambda user_id, course_id, ids: {ids[0]: {"id": ids[0], "file_name": "Lecture.pdf", "active_index_revision": "r1", "page_count": 2}},
    )
    monkeypatch.setattr(stream_router, "_load_canonical_manifest", lambda row: [_FakePage(1), _FakePage(2)])
    monkeypatch.setattr(
        notes, "process_full_documents",
        lambda **kwargs: {
            "answer": "",
            "coverageResult": {"complete": False, "documents": []},
            "sources": [],
        },
    )

    out = notes.generate_notes(
        user_id="u1", course_id="c1", document_ids=["doc-1"],
        topic="Summarize the entire document.", doc_names={"doc-1": "Lecture.pdf"},
    )

    assert out["text"] == ""
    assert "not generate an incomplete summary" in out["warning"]
    assert "fullDocumentCoverage" not in out

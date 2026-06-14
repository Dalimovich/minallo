"""Unit tests for small /ask-stream routing helpers."""

from __future__ import annotations


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

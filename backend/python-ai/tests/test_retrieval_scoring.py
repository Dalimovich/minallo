"""Pure-function tests for retrieval reranking. No network, no DB."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def test_study_score_prefers_solution_over_other() -> None:
    from app.services.retrieval import _study_score

    solution = {"similarity": 0.5, "source_type": "solution", "chunk_text": "Solution: F = m*a", "is_official": True}
    other    = {"similarity": 0.5, "source_type": "other",    "chunk_text": "Random sentence.", "is_official": False}
    assert _study_score(solution) > _study_score(other)


def test_study_score_penalises_toc_lines() -> None:
    from app.services.retrieval import _study_score

    toc_chunk    = {"similarity": 0.4, "source_type": "lecture", "chunk_text": "1 ........... 5\n2 ........... 12"}
    real_content = {"similarity": 0.4, "source_type": "lecture", "chunk_text": "Definition: force = mass times acceleration. Apply F = m * a."}
    assert _study_score(real_content) > _study_score(toc_chunk)


def test_study_score_boosts_formula_text() -> None:
    from app.services.retrieval import _text_study_score

    score_with_formula = _text_study_score("The kinematic equation is v = u + a*t which we apply.")
    score_plain = _text_study_score("This is a normal sentence with no formulas.")
    assert score_with_formula > score_plain


def _row(doc_id: str, chunk_id: str) -> dict:
    return {"id": chunk_id, "document_id": doc_id}


def test_per_document_coverage_splices_missing_docs() -> None:
    from app.services.retrieval import _ensure_per_document_coverage

    # Ranked pool: doc A dominates the top, docs B and C only appear lower down.
    ranked = [
        (0.9, _row("A", "a1")),
        (0.8, _row("A", "a2")),
        (0.7, _row("A", "a3")),
        (0.4, _row("B", "b1")),
        (0.3, _row("C", "c1")),
    ]
    chosen = ranked[:3]  # all from doc A
    out = _ensure_per_document_coverage(
        ranked, chosen, document_ids=["A", "B", "C"], top_k=3
    )
    present = {row["document_id"] for _, row in out}
    assert present == {"A", "B", "C"}  # every selected doc represented


def test_per_document_coverage_noop_when_all_present() -> None:
    from app.services.retrieval import _ensure_per_document_coverage

    ranked = [(0.9, _row("A", "a1")), (0.8, _row("B", "b1"))]
    chosen = ranked[:2]
    out = _ensure_per_document_coverage(
        ranked, chosen, document_ids=["A", "B"], top_k=5
    )
    assert out == chosen


def test_per_document_coverage_noop_for_single_or_no_selection() -> None:
    from app.services.retrieval import _ensure_per_document_coverage

    ranked = [(0.9, _row("A", "a1")), (0.8, _row("B", "b1"))]
    chosen = [ranked[0]]
    assert _ensure_per_document_coverage(ranked, chosen, document_ids=["A"], top_k=5) == chosen
    assert _ensure_per_document_coverage(ranked, chosen, document_ids=None, top_k=5) == chosen

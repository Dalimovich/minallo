"""Pure-function tests for quiz item normalisation."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def test_mcq_accepts_letter_answer() -> None:
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "mcq",
        "question": "What is F?",
        "options": {"A": "mass times acceleration", "B": "energy", "C": "power", "D": "velocity"},
        "answer": "A",
    })
    assert n and n["answer"] == "A"


def test_mcq_accepts_letter_with_paren_answer() -> None:
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "mcq", "question": "What is F?",
        "options": {"A": "x", "B": "y", "C": "z", "D": "w"},
        "answer": "B) explanation",
    })
    assert n and n["answer"] == "B"


def test_mcq_accepts_option_text_answer() -> None:
    from app.services.quiz import _normalize

    n = _normalize({
        "type": "mcq", "question": "What is F?",
        "options": {"A": "mass times acceleration", "B": "energy", "C": "power", "D": "velocity"},
        "answer": "mass times acceleration",
    })
    assert n and n["answer"] == "A"


def test_true_false_normalises_strings() -> None:
    from app.services.quiz import _normalize

    yes = _normalize({"type": "true_false", "question": "Force = mass × acceleration?", "answer": "true"})
    assert yes and yes["answer"] is True
    no = _normalize({"type": "true_false", "question": "Energy = m × v?", "answer": "Falsch"})
    assert no and no["answer"] is False


def test_short_answer_keeps_text() -> None:
    from app.services.quiz import _normalize

    n = _normalize({"type": "short_answer", "question": "Define velocity.", "answer": "Rate of change of displacement."})
    assert n and n["answer"].startswith("Rate")


def test_rejects_unknown_type() -> None:
    from app.services.quiz import _normalize

    assert _normalize({"type": "essay", "question": "...", "answer": "..."}) is None


def test_dedupe_strips_near_duplicates() -> None:
    from app.services.quiz import _dedupe

    items = [
        {"question": "What is Newton's second law?"},
        {"question": "what is newton's second law??"},
        {"question": "What is Hooke's law?"},
    ]
    out = _dedupe(items)
    assert len(out) == 2


def test_deterministic_backfill_honours_requested_count() -> None:
    from app.services.quiz import _deterministic_mcq_backfill
    from app.services.retrieval import RetrievedChunk

    chunks = [
        RetrievedChunk(
            chunk_id=f"c{i}",
            document_id="doc1",
            page_start=i,
            page_end=i,
            text=f"Important course statement number {i} explains the professor's method clearly.",
            score=1.0,
            similarity=0.8,
            chunk_type="lecture",
            section_title="Section",
        )
        for i in range(1, 11)
    ]

    items = _deterministic_mcq_backfill(
        chunks=chunks,
        doc_names={"doc1": "lecture.pdf"},
        needed=10,
        seen_questions=set(),
    )

    assert len(items) == 10
    assert all(item["type"] == "mcq" for item in items)
    assert all(item["source"].startswith("lecture.pdf") for item in items)

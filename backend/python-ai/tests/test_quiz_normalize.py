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


def _mcq(question: str, answer: str) -> dict:
    return {
        "type": "mcq",
        "question": question,
        "options": {"A": "8% Si, 3% Cu", "B": "4% Si, 1% Cu", "C": "8% Cu, 3% other", "D": "8% Cu, 3% Si"},
        "answer": answer,
    }


def _stub_chat_json(monkeypatch, verdicts) -> dict:
    """Patch quiz.chat_json to return the given verdicts; record the call."""
    from app.services import quiz
    from app.services.llm_json import LlmResult

    captured: dict = {}

    def fake(*, system, user, max_tokens):
        captured["called"] = True
        return LlmResult(data={"verdicts": verdicts}, model="gpt-4o-mini", prompt_tokens=100, completion_tokens=20)

    monkeypatch.setattr(quiz, "chat_json", fake)
    return captured


def test_verify_drops_confident_disagreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    # Key says C, verifier confidently says A → drop the item.
    items = [_mcq("What does AlSi8Cu3 mean?", "C")]
    diag = {"prompt_tokens": 0, "completion_tokens": 0}
    _stub_chat_json(monkeypatch, [{"n": 1, "letter": "A", "confident": True}])

    out = _verify_mcq_keys(items, "AlSi8Cu3: aluminium with 8% silicon and 3% copper.", diag)
    assert out == []
    assert diag["prompt_tokens"] == 100  # usage rolled up


def test_verify_keeps_agreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    items = [_mcq("What does AlSi8Cu3 mean?", "A")]
    _stub_chat_json(monkeypatch, [{"n": 1, "letter": "A", "confident": True}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1


def test_verify_keeps_unconfident_disagreement(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    # Verifier disagrees but is not confident → never erode the count.
    items = [_mcq("Ambiguous?", "C")]
    _stub_chat_json(monkeypatch, [{"n": 1, "letter": "A", "confident": False}])
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert len(out) == 1


def test_verify_passes_through_on_llm_failure(monkeypatch) -> None:
    from app.services import quiz
    from app.services.quiz import _verify_mcq_keys

    def boom(*, system, user, max_tokens):
        raise RuntimeError("openai down")

    monkeypatch.setattr(quiz, "chat_json", boom)
    items = [_mcq("Q?", "C")]
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert out == items  # verification must never block a quiz


def test_verify_skips_when_no_mcqs(monkeypatch) -> None:
    from app.services.quiz import _verify_mcq_keys

    captured = _stub_chat_json(monkeypatch, [])
    items = [{"type": "true_false", "question": "F = m·a?", "answer": True}]
    out = _verify_mcq_keys(items, "ctx", {"prompt_tokens": 0, "completion_tokens": 0})
    assert out == items
    assert "called" not in captured  # no LLM call when there is nothing to verify


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

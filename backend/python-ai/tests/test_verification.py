"""Phase 10 — deterministic verification status."""

from __future__ import annotations

import pytest

from app.services.verification import (
    VERIFICATION_STATUSES,
    verify_answer,
)


# ── happy paths ─────────────────────────────────────────────────────────────


def test_fully_grounded_answer_is_verified() -> None:
    chunk = "The bending moment is $$ M = F \\cdot l $$ where F is the applied force."
    answer = (
        "Based on your uploaded files [Source 1]:\n"
        "The bending moment formula is $$ M = F \\cdot l $$.\n"
    )
    res = verify_answer(answer_text=answer, chunk_texts=[chunk], question="What is M?")
    assert res.status == "verified"
    assert res.details["formulaCount"] == 1
    assert res.details["formulaMisses"] == []
    assert res.details["hasCitation"] is True


def test_grounded_numbers_from_question_are_accepted() -> None:
    # The "200" and "0.5" come from the user's question, not the chunk.
    # That counts as grounded.
    chunk = "The bending moment formula is $$ M = F \\cdot l $$."
    question = "Calculate the bending moment when F = 200 N and l = 0.5 m"
    answer = (
        "Based on your uploaded files [Source 1]:\n"
        "$$ M = F \\cdot l = 200 \\cdot 0.5 = 100\\ \\mathrm{Nm} $$\n"
    )
    res = verify_answer(answer_text=answer, chunk_texts=[chunk], question=question)
    # 100 comes from arithmetic on user-supplied numbers — flag is fine; we
    # only need "verified" or "partially_verified" here, never missing.
    assert res.status in {"verified", "partially_verified"}


# ── missing-context paths ───────────────────────────────────────────────────


def test_empty_answer_is_missing_context() -> None:
    res = verify_answer(answer_text="", chunk_texts=["any"], question="q")
    assert res.status == "missing_context"


def test_no_chunks_is_missing_context() -> None:
    # Even with a great-looking answer, no retrieved context → missing.
    res = verify_answer(
        answer_text="The answer is 42 [Source 1].",
        chunk_texts=[],
        question="q",
    )
    assert res.status == "missing_context"


def test_self_report_missing_context_wins() -> None:
    chunk = "$$ E = mc^2 $$"
    answer = (
        "Based on your files [Source 1]:\n$$ E = mc^2 $$\n"
        "### Confidence\nMissing context — the exercise statement isn't in the uploaded files.\n"
    )
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    assert res.status == "missing_context"
    assert any("self-reported" in r for r in res.reasons)


# ── partial-verification paths ──────────────────────────────────────────────


def test_missing_citation_downgrades_to_partial() -> None:
    chunk = "Newton's second law: $$ F = m a $$"
    answer = "The formula is $$ F = m a $$ — applied force equals mass times acceleration."
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    assert res.status == "partially_verified"
    assert any("citation" in r for r in res.reasons)


def test_formula_not_in_context_downgrades() -> None:
    chunk = "Section 3 discusses simple beam theory."
    answer = "Based on the file [Source 1], $$ \\sigma = M y / I $$ holds."
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    assert res.status == "partially_verified"
    assert any("formula" in r for r in res.reasons)


def test_number_not_in_context_or_question_downgrades() -> None:
    chunk = "Bending moment formula: $$ M = F l $$. Example given on page 4."
    answer = "Based on [Source 1]: with F = 999 N and l = 0.5 m, M = 499.5 Nm."
    res = verify_answer(answer_text=answer, chunk_texts=[chunk], question="What is M?")
    assert res.status == "partially_verified"
    assert any("number" in r for r in res.reasons)


def test_self_report_partial_downgrades_verified_to_partial() -> None:
    chunk = "$$ E = mc^2 $$"
    answer = (
        "Based on your files [Source 1]:\n$$ E = mc^2 $$\n"
        "### Confidence\nPartially verified — derivation step not in the file.\n"
    )
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    assert res.status == "partially_verified"


# ── enum contract ──────────────────────────────────────────────────────────


def test_status_always_in_enum() -> None:
    cases = [
        ("", []),
        ("answer", []),
        ("answer", ["chunk"]),
        ("$$x=y$$ [Source 1]", ["$$x=y$$"]),
    ]
    for ans, chunks in cases:
        assert verify_answer(answer_text=ans, chunk_texts=chunks).status in VERIFICATION_STATUSES


def test_to_api_shape() -> None:
    res = verify_answer(answer_text="x", chunk_texts=[])
    payload = res.to_api()
    assert set(payload.keys()) == {"status", "reasons", "details"}


# ── normalization helpers ──────────────────────────────────────────────────


def test_formula_whitespace_differences_dont_flag() -> None:
    chunk = "$$M = F\\cdot l$$"  # no spaces
    answer = "Based on [Source 1]: $$ M = F \\cdot l $$"  # with spaces
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    assert res.details["formulaMisses"] == []


def test_decimal_comma_form_matches_decimal_dot_form() -> None:
    chunk = "Given l = 0,5 m"
    answer = "Based on [Source 1]: the length is 0.5 m."
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    # The "0.5" in answer should match "0,5" in chunk — no number miss.
    assert "0.5" not in res.details["numberMisses"]

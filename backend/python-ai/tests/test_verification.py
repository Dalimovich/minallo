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


def test_missing_citation_collapses_to_missing_context() -> None:
    # Updated contract: a `[Source N]` tag is the ONLY accepted citation
    # anchor. Without one, no part of the answer is verifiable — collapse
    # straight to missing_context rather than partially_verified.
    chunk = "Newton's second law: $$ F = m a $$"
    answer = "The formula is $$ F = m a $$ — applied force equals mass times acceleration."
    res = verify_answer(answer_text=answer, chunk_texts=[chunk])
    assert res.status == "missing_context"
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


# ── Review fix #9 — operator-overlap in rearrangement check ────────────────


def test_rearrangement_requires_operator_overlap() -> None:
    """Same variable set but completely different operator profile
    must NOT count as a rearrangement. Without the operator check
    ``F = m·a`` and ``E = m·c²`` would both share {m} (c is in the
    trivial-vars set) and slip through — but they're obviously
    different formulas."""
    from app.services.verification import _formula_is_rearrangement_of_cited

    cited = ["The general force law is F = m \\cdot a where m is mass."]
    # `E = m \\cdot c^{2}` — same `m` variable, totally different shape
    # (involves `^` for squaring vs no exponent in the original).
    assert not _formula_is_rearrangement_of_cited(
        "E = m \\cdot c^{2}",
        cited,
    )


def test_rearrangement_accepts_genuine_algebraic_restatement() -> None:
    """Real rearrangements still pass — same variables AND overlapping
    operator structure. ``τ = F/A`` restated as ``F = τ·A`` keeps the
    set {τ, F, A} and both involve multiplicative ops (/ and ·)."""
    from app.services.verification import _formula_is_rearrangement_of_cited

    cited = ["Shear stress is given by τ = F / A in the simplest case."]
    assert _formula_is_rearrangement_of_cited("F = τ \\cdot A", cited)


def test_rearrangement_rejects_different_structure_same_letters() -> None:
    """A `\\sum` formula vs a `\\frac` formula with overlapping letters
    must not be confused for rearrangements."""
    from app.services.verification import _formula_is_rearrangement_of_cited

    cited = ["The sum is S = \\sum_{i=1}^{n} a_i b_i."]
    # Same {S, a, b} but fraction-shaped, no summation — different formula.
    assert not _formula_is_rearrangement_of_cited(
        "S = a / b",
        cited,
    )

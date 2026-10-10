"""Phase 7 — conservative math query expansion."""

from __future__ import annotations

import sys
import types

import pytest


def _import_qe():
    """Stub native deps so we can import the expansion module fresh."""
    fake_sb = types.ModuleType("app.supabase_client")
    fake_sb.get_supabase = lambda: None
    sys.modules.setdefault("app.supabase_client", fake_sb)
    fake_emb = types.ModuleType("app.services.embeddings")
    fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
    sys.modules.setdefault("app.services.embeddings", fake_emb)
    if "app.services.query_expansion" in sys.modules:
        del sys.modules["app.services.query_expansion"]
    if "app.services.retrieval" in sys.modules:
        del sys.modules["app.services.retrieval"]
    from app.services import query_expansion  # noqa: WPS433
    return query_expansion


# ── is_math_question ────────────────────────────────────────────────────────


@pytest.mark.parametrize("q", [
    "Solve Problem 2",
    "Calculate the bending moment when F = 200 N and l = 0.5 m",
    "Derive the formula for cantilever deflection",
    "Prove that sin² + cos² = 1",
    "Aufgabe 1.2",
    "Übung 3 (a) bitte",
    "Give me the formula for shear force",
    "What is sigma when F = 100 N and A = 0.01 m²?",
    "An object is dropped in a vacuum fall shaft with l = 200 m and a = -50g",
    "Berechne das Moment",
    "Solve for x when x = 2y + 3",
])
def test_is_math_question_true(q: str) -> None:
    qe = _import_qe()
    assert qe.is_math_question(q) is True, q


@pytest.mark.parametrize("q", [
    "Summarize chapter 2",
    "What's the weather today?",
    "Who wrote this lecture?",
    "Explain in plain English",
    "Read me the introduction",
    "",
])
def test_is_math_question_false(q: str) -> None:
    qe = _import_qe()
    assert qe.is_math_question(q) is False, q


# ── expand_query ────────────────────────────────────────────────────────────


def test_non_math_question_is_not_expanded() -> None:
    qe = _import_qe()
    res = qe.expand_query("Summarize chapter 2")
    assert res.expanded is False
    assert res.text == "Summarize chapter 2"
    assert res.exercise_number is None


def test_math_question_without_exercise_ref_is_not_expanded() -> None:
    """Don't add synonym tokens when there's no exercise number — would
    only add BM25 noise."""
    qe = _import_qe()
    res = qe.expand_query("Calculate the bending moment when F = 200 N and l = 0.5 m")
    assert res.expanded is False
    assert res.exercise_number is None


def test_exercise_ref_expands_to_all_variants() -> None:
    qe = _import_qe()
    res = qe.expand_query("Aufgabe 1.2")
    assert res.expanded is True
    assert res.exercise_number == "1.2"
    assert res.subpart is None
    # Every keyword variant must be present in the expanded text.
    for kw in ("Aufgabe", "Übung", "Exercise", "Problem", "Task", "Beispiel"):
        assert f"{kw} 1.2" in res.text, kw
    # Solution variants too.
    for kw in ("Lösung", "Solution", "Musterlösung"):
        assert f"{kw} 1.2" in res.text, kw
    # Original question is preserved at the front (lets BM25 still see the
    # raw phrase verbatim).
    assert res.text.startswith("Aufgabe 1.2")


def test_exercise_ref_with_subpart_expands_with_parens() -> None:
    qe = _import_qe()
    res = qe.expand_query("Übung 3 (a) lösen")
    assert res.exercise_number == "3"
    assert res.subpart == "a"
    assert "Exercise 3 (a)" in res.text
    assert "Aufgabe 3 (a)" in res.text


def test_bare_section_reference_does_not_expand() -> None:
    """Section refs like "1.2" without an exercise keyword must NOT be
    expanded — would short-circuit retrieval for casual mentions."""
    qe = _import_qe()
    res = qe.expand_query("See section 1.2 for context.")
    assert res.expanded is False
    assert res.exercise_number is None


def test_empty_query() -> None:
    qe = _import_qe()
    res = qe.expand_query("")
    assert res.expanded is False
    assert res.text == ""


def test_multilingual_technical_expansion_preserves_original_query() -> None:
    qe = _import_qe()
    res = qe.expand_query("Calculate the Standzeit.")
    assert res.text.startswith("Calculate the Standzeit.")
    assert "tool life" in res.text
    assert res.expanded


def test_distinct_moments_of_inertia_are_not_conflated() -> None:
    qe = _import_qe()
    mass = qe.expand_query("Explain the Massenträgheitsmoment")
    assert "mass moment of inertia" in mass.text
    assert "second moment of area" not in mass.text

    area = qe.expand_query("Explain the Flächenträgheitsmoment")
    assert "second moment of area" in area.text
    assert "mass moment of inertia" not in area.text

"""Phase 9 — math answer format. Tests for ``pick_system_prompt``.

Stubs ``openai`` before importing answer.py so the test doesn't need
the openai SDK installed locally.
"""

from __future__ import annotations

import sys
import types

import pytest

# Stub openai so answer.py imports cleanly.
_fake_openai = types.ModuleType("openai")
_fake_openai.OpenAI = lambda **kwargs: None  # noqa: ARG005
sys.modules.setdefault("openai", _fake_openai)

# Stub supabase + embeddings so retrieval.py (transitively imported by
# query_expansion -> pick_system_prompt) loads without native deps.
_fake_sb = types.ModuleType("app.supabase_client")
_fake_sb.get_supabase = lambda: None
sys.modules.setdefault("app.supabase_client", _fake_sb)
_fake_emb = types.ModuleType("app.services.embeddings")
_fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
sys.modules.setdefault("app.services.embeddings", _fake_emb)

# NOTE: we used to stub `app.config` here so the test would run without
# pydantic. That stub leaked into the rest of the test session — replacing
# `get_settings` with a plain `lambda` — and broke every later test that
# expected `get_settings.cache_clear()` (the real impl is `@lru_cache`).
# pydantic-settings IS available in CI/dev now, and conftest.py seeds the
# required env vars at session start, so the real `app.config` loads fine.

from app.services.answer import (  # noqa: E402
    _SYSTEM_PROMPT_MATH,
    _SYSTEM_PROMPT_PARTIAL,
    _SYSTEM_PROMPT_STRONG,
    _SYSTEM_PROMPT_WEAK,
    pick_system_prompt,
)


# ── weak retrieval always wins, even for math questions ────────────────────


# `pick_system_prompt` returns the chosen base prompt with overlays appended
# (tutor mode, optional weak-topic coaching, and the always-on DIGNITY_OVERLAY).
# The old `is`-identity check broke as soon as ANY overlay was added.
# `startswith` is the right contract: the base template must lead, overlays
# follow.


def test_weak_retrieval_uses_partial_prompt_even_for_math() -> None:
    """Review fix #3: weak-strength retrieval no longer throws chunks
    away. We feed the top 2-3 to the model with the PARTIAL prompt that
    forbids confident solving but encourages "here's what your files
    DO cover" — much more useful than the old "I found nothing" reply."""
    prompt, mode = pick_system_prompt("Solve Aufgabe 1.2", "weak")
    assert prompt.startswith(_SYSTEM_PROMPT_PARTIAL)
    assert mode == "partial"


def test_none_retrieval_uses_weak_prompt() -> None:
    """``none`` strength means no chunks at all — nothing to surface.
    Fall back to the original "I couldn't find this in your files" reply."""
    prompt, mode = pick_system_prompt("Aufgabe 1.2", "none")
    assert prompt.startswith(_SYSTEM_PROMPT_WEAK)
    assert mode == "weak"


# ── strong retrieval routes by question type ───────────────────────────────


@pytest.mark.parametrize("q", [
    "Solve Problem 2",
    "Calculate the bending moment when F = 200 N and l = 0.5 m",
    "Derive the formula for cantilever deflection",
    "Prove that sin² + cos² = 1",
    "Aufgabe 1.2",
    "Übung 3 (a)",
    "Give me the formula for shear force",
    "Berechne das Moment",
])
def test_math_question_with_strong_context_uses_math_prompt(q: str) -> None:
    prompt, mode = pick_system_prompt(q, "strong")
    assert prompt.startswith(_SYSTEM_PROMPT_MATH)
    assert mode == "math"


@pytest.mark.parametrize("q", [
    "Summarize chapter 2",
    "Who wrote this lecture?",
    "Explain in plain English",
    "What is the main idea?",
])
def test_non_math_question_with_strong_context_uses_strong_prompt(q: str) -> None:
    prompt, mode = pick_system_prompt(q, "strong")
    assert prompt.startswith(_SYSTEM_PROMPT_STRONG)
    assert mode == "strong"


# ── math prompt contract — must mention every section the template requires ─


def test_math_prompt_contains_required_sections() -> None:
    body = _SYSTEM_PROMPT_MATH
    # The "Sources used" preamble was removed — citations are now inline,
    # not listed up-front. The remaining sections are still mandatory.
    for heading in (
        "Given", "Required", "Formula",
        "Substitution", "Calculation", "Unit check", "Final answer",
        "Confidence",
    ):
        assert heading in body, f"math prompt missing required section: {heading}"


def test_math_prompt_mentions_verification_states() -> None:
    body = _SYSTEM_PROMPT_MATH
    for label in ("Verified", "Partially verified", "Missing context"):
        assert label in body, f"math prompt missing verification label: {label}"


def test_math_prompt_forbids_invention() -> None:
    body = _SYSTEM_PROMPT_MATH.lower()
    # The anti-hallucination clause must survive future edits.
    assert "do not invent" in body


# ── Review fix #7 — RetrievalCompleteness ─────────────────────────────────


def _mk_chunk(text: str, chunk_type: str = "general", similarity: float = 0.6) -> object:
    """Minimal chunk shim — assess_retrieval_completeness reads `.text`
    via getattr, so a simple namespace object is enough."""
    from types import SimpleNamespace
    return SimpleNamespace(text=text, chunk_type=chunk_type, similarity=similarity)


def test_completeness_empty_or_none_is_all_false() -> None:
    from app.services.answer import assess_retrieval_completeness
    r = assess_retrieval_completeness(None)
    assert r.has_exercise_statement is False
    assert r.has_formula is False
    assert r.has_given_values is False
    assert r.has_solution_or_method is False
    assert r.is_complete_for_math is False


def test_completeness_full_exercise_chunk_is_complete_for_math() -> None:
    """A typical exercise statement chunk has the words, the formula,
    and several `symbol = number` patterns — all three signals fire."""
    from app.services.answer import assess_retrieval_completeness
    text = (
        "Aufgabe 9.1: Bestimmen Sie die Nachgiebigkeit. "
        "Gegeben: F = 200 N, l = 0,5 m, E = 210000 N/mm², "
        "A = 100 mm². "
        "Die Formel lautet δ = l / (A · E)."
    )
    r = assess_retrieval_completeness([_mk_chunk(text)])
    assert r.has_exercise_statement
    assert r.has_formula
    assert r.has_given_values
    assert r.is_complete_for_math


def test_completeness_formula_only_chunk_misses_statement_and_givens() -> None:
    """A Formelzettel page has formulas but no exercise statement and
    no instance-level givens — should NOT be marked complete enough for
    the rigid math template alone."""
    from app.services.answer import assess_retrieval_completeness
    text = "δ_K = l_K / (E_S · A_N)  δ_G = 0.5 · d / (E_S · A_3)"
    r = assess_retrieval_completeness([_mk_chunk(text)])
    assert r.has_formula
    assert not r.has_exercise_statement
    assert not r.has_given_values
    assert not r.is_complete_for_math


def test_completeness_statement_only_chunk_misses_formula() -> None:
    """An exercise sheet that defines the task but doesn't print the
    formula is also incomplete — needs a separate formula chunk."""
    from app.services.answer import assess_retrieval_completeness
    text = (
        "Übungsaufgabe 9.1: Berechnen Sie die Nachgiebigkeit "
        "der Schraubenverbindung."
    )
    r = assess_retrieval_completeness([_mk_chunk(text)])
    assert r.has_exercise_statement
    assert not r.has_formula
    assert not r.is_complete_for_math


def test_completeness_combines_across_chunks() -> None:
    """The three signals can come from DIFFERENT chunks — that's the
    normal RAG case: one chunk has the exercise, another has the
    formula, a third has the given values."""
    from app.services.answer import assess_retrieval_completeness
    chunks = [
        _mk_chunk("Aufgabe 9.1: Bestimmen Sie die Nachgiebigkeit."),
        _mk_chunk("δ_K = l_K / (E_S · A_N)"),
        _mk_chunk("Gegeben: F = 12500 N, E_S = 210000 N/mm², d = 24 mm."),
    ]
    r = assess_retrieval_completeness(chunks)
    assert r.is_complete_for_math


def test_completeness_to_api_shape() -> None:
    """The API shape must match what answer_stream / ask responses
    expose — locked in so a future refactor doesn't silently drop a
    field the frontend / debug UI relies on."""
    from app.services.answer import RetrievalCompleteness
    r = RetrievalCompleteness(True, True, True, False)
    api = r.to_api()
    assert api == {
        "hasExerciseStatement":  True,
        "hasFormula":            True,
        "hasGivenValues":        True,
        "hasSolutionOrMethod":   False,
        "isCompleteForMath":     True,
    }


def test_math_template_now_requires_completeness() -> None:
    """``pick_system_prompt`` should fall back to the STRONG (explanatory)
    prompt — not the rigid MATH worksheet — when retrieval is strong but
    the chunks lack one of the math-readiness components. Previously,
    has_exercise_anchor + has_formula was enough; now givens are required
    too so the model doesn't fill the Substitution section with
    placeholders."""
    from app.services.answer import pick_system_prompt
    chunks = [
        _mk_chunk(
            "Übung 1.2: δ = l / (A·E)",
            chunk_type="exercise",
            similarity=0.5,  # strong-similarity anchor
        ),
    ]
    # Strong retrieval but no given values in any chunk → no MATH template.
    prompt, mode = pick_system_prompt("Berechne δ", "strong", chunks)
    assert mode == "strong"
    # Now add a chunk with explicit givens — same query, same other inputs.
    chunks.append(_mk_chunk("Gegeben: l = 0,5 m, A = 100 mm², E = 210000 N/mm²"))
    prompt, mode = pick_system_prompt("Berechne δ", "strong", chunks)
    assert mode == "math"

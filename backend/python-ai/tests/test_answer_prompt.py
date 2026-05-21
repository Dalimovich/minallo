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

"""Tests for major-agnostic academic answer intent classification."""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest

_fake_sb = types.ModuleType("app.supabase_client")
_fake_sb.get_supabase = lambda: None
sys.modules.setdefault("app.supabase_client", _fake_sb)
_fake_emb = types.ModuleType("app.services.embeddings")
_fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
sys.modules.setdefault("app.services.embeddings", _fake_emb)

from app.services.answer_intent import AcademicIntent, classify_academic_intent  # noqa: E402


@pytest.mark.parametrize(
    ("question", "intent"),
    [
        ("Calculate the bending moment when F = 200 N and l = 0.5 m.", AcademicIntent.MATH_PROBLEM),
        ("Compute the standard deviation for 4, 7, 9, and 12.", AcademicIntent.MATH_PROBLEM),
        ("Calculate ROI from revenue 1200 EUR and cost 900 EUR.", AcademicIntent.MATH_PROBLEM),
        ("Calculate the medication dose for 70 kg at 5 mg/kg.", AcademicIntent.MATH_PROBLEM),
        ("Explain kinetic energy, then calculate it for m = 2 kg and v = 3 m/s.", AcademicIntent.MIXED_MATH_AND_CONCEPT),
        ("Explain this medical case and what the symptoms suggest.", AcademicIntent.CASE_OR_APPLICATION_REASONING),
        ("Analyze this business problem and recommend a strategy.", AcademicIntent.CASE_OR_APPLICATION_REASONING),
        ("Apply this ethics framework to the scenario.", AcademicIntent.CASE_OR_APPLICATION_REASONING),
        ("Compare segmentation and positioning in marketing.", AcademicIntent.COMPARISON),
        ("Summarize this lecture page.", AcademicIntent.COURSE_SUMMARY),
        ("What is the definition of consideration in contract law?", AcademicIntent.DEFINITION_OR_THEOREM),
        ("Create a quiz from these notes.", AcademicIntent.QUIZ_GENERATION),
        ("Make flashcards for chapter 3.", AcademicIntent.FLASHCARD_GENERATION),
        ("Debug this Python error.", AcademicIntent.CODE_PROBLEM),
        ("How can I upload a PDF in Minallo?", AcademicIntent.APP_QUESTION),
    ],
)
def test_classifies_major_agnostic_intents(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


@pytest.mark.parametrize(
    "question",
    [
        "Explain this medical case",
        "What solution does the author propose?",
        "Analyze this business problem",
        "Explain Aufgabe 1, do not solve it",
    ],
)
def test_math_false_positives_stay_non_math(question: str) -> None:
    assert classify_academic_intent(question) not in {
        AcademicIntent.MATH_PROBLEM,
        AcademicIntent.MIXED_MATH_AND_CONCEPT,
    }


def test_deictic_visible_numeric_problem_routes_to_math() -> None:
    chunks = [
        SimpleNamespace(
            text=(
                "Problem 1: Given m = 2 kg and a = 4 m/s^2. "
                "Find the force using F = m * a."
            ),
            chunk_type="exercise",
            similarity=1.0,
        )
    ]

    assert classify_academic_intent("solve this", chunks) == AcademicIntent.MATH_PROBLEM


def test_explain_visible_problem_without_solving_stays_conceptual() -> None:
    chunks = [
        SimpleNamespace(
            text="Aufgabe 1: Given m = 2 kg and a = 4 m/s^2. Find F = m * a.",
            chunk_type="exercise",
            similarity=1.0,
        )
    ]

    assert classify_academic_intent("Explain Aufgabe 1, do not solve it", chunks) == AcademicIntent.CONCEPTUAL_EXPLANATION

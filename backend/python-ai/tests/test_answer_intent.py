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


def test_exam_generation_intent() -> None:
    from app.services.answer_intent import classify_academic_intent, AcademicIntent

    for q in ["create a practice exam from my files", "generate an exam with math questions",
              "erstelle eine Probeklausur", "make me a mock exam"]:
        assert classify_academic_intent(q) == AcademicIntent.EXAM_GENERATION, q


def test_summary_of_exam_is_not_exam_generation() -> None:
    from app.services.answer_intent import classify_academic_intent, AcademicIntent

    assert classify_academic_intent("give me a summary of the exam topics") == AcademicIntent.COURSE_SUMMARY


def test_wants_per_source_coverage() -> None:
    from app.services.answer_intent import wants_per_source_coverage

    for q in ["a question for every lecture I have selected", "one question per file",
              "a question for each chapter", "alle Vorlesungen", "für jede Datei eine Frage"]:
        assert wants_per_source_coverage(q), q
    assert not wants_per_source_coverage("explain chapter 2")
    assert not wants_per_source_coverage("what is Urformen")


def test_non_academic_chitchat_is_not_course_work() -> None:
    from app.services.answer_intent import chitchat_answer, is_non_academic_chitchat

    # Pure social/acknowledgement turns (incl. German "wie gehts" without an
    # apostrophe, which used to slip through and trigger a RAG/exam answer).
    for q in ["hi", "Hello!", "thanks", "ok", "how are you?", "danke", "wie gehts", "cool", "perfect"]:
        assert is_non_academic_chitchat(q), q
        assert "Source" not in chitchat_answer(q)

    # A bare acknowledgement gets an acknowledgement reply, not a greeting.
    assert chitchat_answer("ok") == "Got it. What would you like to work on next?"

    for q in ["hi, explain entropy", "what is force?", "ok explain chapter 2", "thanks, now make a quiz"]:
        assert not is_non_academic_chitchat(q), q


def test_exam_overlay_lists_files_and_demands_coverage() -> None:
    from app.services.answer import build_source_coverage_overlay
    from app.services.retrieval import RetrievedChunk

    def chunk(doc_id: str, cid: str) -> RetrievedChunk:
        return RetrievedChunk(chunk_id=cid, document_id=doc_id, page_start=1, page_end=1,
                              text="x", score=1.0, similarity=0.5, chunk_type="lecture", section_title=None)

    chunks = [chunk("d1", "c1"), chunk("d2", "c2"), chunk("d1", "c3")]
    names = {"d1": "Kapitel_1.pdf", "d2": "Kapitel_2.pdf"}
    overlay = build_source_coverage_overlay(chunks, names, exam=True)
    assert "Kapitel_1.pdf" in overlay and "Kapitel_2.pdf" in overlay
    assert "Aufgabe" in overlay and "EACH of the 2 files" in overlay
    # Single doc -> no overlay (nothing to enforce coverage over).
    assert build_source_coverage_overlay([chunk("d1", "c1")], names, exam=True) == ""


def test_overlay_uses_selection_as_contract_and_reports_not_ready() -> None:
    from app.services.answer import build_source_coverage_overlay
    from app.services.retrieval import RetrievedChunk

    def chunk(doc_id: str, cid: str) -> RetrievedChunk:
        return RetrievedChunk(chunk_id=cid, document_id=doc_id, page_start=1, page_end=1,
                              text="x", score=1.0, similarity=0.5, chunk_type="lecture", section_title=None)

    # d1/d2 have chunks; d3 was selected but produced none (still processing).
    chunks = [chunk("d1", "c1"), chunk("d2", "c2")]
    names = {"d1": "K1.pdf", "d2": "K2.pdf", "d3": "K3.pdf"}
    overlay = build_source_coverage_overlay(
        chunks, names, exam=True, selected_file_names=["K1.pdf", "K2.pdf", "K3.pdf"]
    )
    assert "K1.pdf" in overlay and "K2.pdf" in overlay
    assert "STILL PROCESSING" in overlay and "K3.pdf" in overlay
    # Covered files keep their [Source N] numbering; not-ready file isn't numbered.
    assert "[Source 1] K1.pdf" in overlay

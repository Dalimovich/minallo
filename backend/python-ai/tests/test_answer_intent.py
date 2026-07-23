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


@pytest.mark.parametrize(
    ("question", "intent"),
    [
        # Grading / checking the student's own work.
        ("is my answer correct?", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),
        ("correct my solution", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),
        ("how many points would I get?", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),
        ("check my work", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),
        ("where did I make a mistake", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),
        ("korrigiere meine Loesung", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),
        # Practice variant of an existing problem.
        ("give me another Aufgabe like this", AcademicIntent.PRACTICE_VARIANT_GENERATION),
        ("make a similar problem", AcademicIntent.PRACTICE_VARIANT_GENERATION),
        ("let me practice this type", AcademicIntent.PRACTICE_VARIANT_GENERATION),
        # Formula extraction / Formelsammlung.
        ("list all formulas from this chapter", AcademicIntent.FORMULA_EXTRACTION),
        ("make a Formelsammlung", AcademicIntent.FORMULA_EXTRACTION),
        ("what formulas do I need for the exam", AcademicIntent.FORMULA_EXTRACTION),
        # Source / citation lookup.
        ("where is the Grove diagram mentioned?", AcademicIntent.SOURCE_FINDING),
        ("which file says this", AcademicIntent.SOURCE_FINDING),
        ("show me the source", AcademicIntent.SOURCE_FINDING),
        ("in which chapter is this defined", AcademicIntent.SOURCE_FINDING),
        # Explaining one formula (vs listing them all).
        ("explain this formula", AcademicIntent.FORMULA_EXPLANATION),
        ("what does each variable mean in this equation", AcademicIntent.FORMULA_EXPLANATION),
        ("when should I use this formula", AcademicIntent.FORMULA_EXPLANATION),
        ("erklaere diese Formel", AcademicIntent.FORMULA_EXPLANATION),
        # Exam-priority list (not a timed plan).
        ("what's important for the exam", AcademicIntent.EXAM_PRIORITY_LIST),
        ("what should I focus on", AcademicIntent.EXAM_PRIORITY_LIST),
        ("what is likely to appear on the exam", AcademicIntent.EXAM_PRIORITY_LIST),
        ("most important topics", AcademicIntent.EXAM_PRIORITY_LIST),
        # Batch 3: translation / simplification / misconception / cross-file.
        ("translate this paragraph to English", AcademicIntent.TRANSLATION),
        ("was heisst das auf Englisch", AcademicIntent.TRANSLATION),
        ("what does this German sentence mean", AcademicIntent.TRANSLATION),
        ("explain this in simpler terms", AcademicIntent.LANGUAGE_SIMPLIFICATION),
        ("explain entropy for beginners", AcademicIntent.LANGUAGE_SIMPLIFICATION),
        ("erklaere das einfacher", AcademicIntent.LANGUAGE_SIMPLIFICATION),
        ("Kaltumformen happens above the recrystallization temperature, right?", AcademicIntent.MISCONCEPTION_CHECK),
        ("is this the same as that", AcademicIntent.MISCONCEPTION_CHECK),
        ("combine all the selected files", AcademicIntent.CROSS_FILE_SYNTHESIS),
        ("how do these topics relate", AcademicIntent.CROSS_FILE_SYNTHESIS),
        # Batch 4: oral / complete-notes / fill-gaps / multi-source / output-review.
        ("ask me like in an oral exam", AcademicIntent.ORAL_EXAM_PRACTICE),
        ("pruef mich muendlich", AcademicIntent.ORAL_EXAM_PRACTICE),
        ("ask me one question at a time", AcademicIntent.ORAL_EXAM_PRACTICE),
        ("complete my notes", AcademicIntent.COMPLETE_NOTES),
        ("extend my notes", AcademicIntent.COMPLETE_NOTES),
        ("fill in the blanks", AcademicIntent.FILL_GAPS),
        ("complete the missing terms", AcademicIntent.FILL_GAPS),
        ("compare these two files", AcademicIntent.MULTI_SOURCE_COMPARISON),
        ("compare chapter 4.1 and 4.2", AcademicIntent.MULTI_SOURCE_COMPARISON),
        ("is this generated exam good?", AcademicIntent.GENERATED_OUTPUT_REVIEW),
        ("rate this Minallo answer", AcademicIntent.GENERATED_OUTPUT_REVIEW),
        ("why did the AI answer like this", AcademicIntent.GENERATED_OUTPUT_REVIEW),
    ],
)
def test_classifies_new_student_workflow_intents(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


@pytest.mark.parametrize(
    ("question", "intent"),
    [
        # Batch-4 guards: must keep existing routing.
        ("create a quiz", AcademicIntent.QUIZ_GENERATION),
        ("test me on chapter 3", AcademicIntent.QUIZ_GENERATION),
        ("compare A and B", AcademicIntent.COMPARISON),                       # concepts, not files
        ("compare photosynthesis and respiration", AcademicIntent.COMPARISON),
        ("rate my answer", AcademicIntent.ANSWER_CORRECTION_OR_GRADING),      # student's, not AI's
    ],
)
def test_batch4_intents_stay_high_precision(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


def test_self_contained_intents_skip_grounding() -> None:
    from app.services.answer_intent import intent_is_self_contained as sc

    assert sc(AcademicIntent.TRANSLATION)
    assert sc(AcademicIntent.LANGUAGE_SIMPLIFICATION)
    assert sc(AcademicIntent.GENERATED_OUTPUT_REVIEW)
    # Grounded intents must NOT skip retrieval.
    assert not sc(AcademicIntent.MISCONCEPTION_CHECK)
    assert not sc(AcademicIntent.ORAL_EXAM_PRACTICE)
    assert not sc(AcademicIntent.EXAM_GENERATION)


@pytest.mark.parametrize(
    ("question", "intent"),
    [
        # Batch-3 high-precision guards (must keep existing routing).
        ("study in German tonight", AcademicIntent.GENERAL_COURSE_QA),
        ("explain entropy in English", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("simplify this expression", AcademicIntent.MATH_PROBLEM),
        ("compare A and B", AcademicIntent.COMPARISON),
        ("summarize all files", AcademicIntent.COURSE_SUMMARY),
    ],
)
def test_batch3_intents_stay_high_precision(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


@pytest.mark.parametrize(
    "question",
    [
        "explain entropy like my professor",
        "answer in Musterloesung style",
        "give me an exam-ready answer",
        "what would the exam expect",
        "use the course wording",
    ],
)
def test_professor_style_is_a_flag_not_an_intent(question: str) -> None:
    from app.services.answer_intent import wants_professor_style

    # The flag fires...
    assert wants_professor_style(question)
    # ...but it must NOT hijack the base intent (it's layered on top).
    assert classify_academic_intent("explain entropy like my professor") == (
        AcademicIntent.CONCEPTUAL_EXPLANATION
    )
    assert not wants_professor_style("explain entropy")


@pytest.mark.parametrize(
    ("question", "intent"),
    [
        # High-precision: these must NOT trip the new intents (regression guard).
        ("explain how this process works", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("where does energy come from in this reaction", AcademicIntent.GENERAL_COURSE_QA),
        # "is X correct" without an answer/solution noun must NOT become grading.
        ("is this proof correct", AcademicIntent.GENERAL_COURSE_QA),
        ("create a quiz", AcademicIntent.QUIZ_GENERATION),
        ("generate an exam from my files", AcademicIntent.EXAM_GENERATION),
    ],
)
def test_new_intents_do_not_steal_existing_traffic(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


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

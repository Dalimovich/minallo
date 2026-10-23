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

from app.services.answer_intent import AcademicIntent, classify_academic_intent, intent_style_instruction  # noqa: E402


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


@pytest.mark.parametrize(
    "question",
    [
        "hhh", "haha", "hahaha", "lol", "lmao", "😂", "🤣",
        "I was just laughing", "that was funny", "nothing",
        "nothing that concerns you", "never mind", "forget it",
        "doesn't matter", "none of your business", "just joking",
        "I'm kidding", "yeah", "yep", "nope", "sure", "alright",
        "fair enough", "exactly", "right", "got it", "I see",
    ],
)
def test_natural_social_turns_exit_before_course_work(question: str) -> None:
    from app.services.answer_intent import chitchat_answer, is_non_academic_chitchat

    assert is_non_academic_chitchat(question)
    assert chitchat_answer(question)
    assert "Source" not in chitchat_answer(question)


@pytest.mark.parametrize(
    "question",
    [
        "nothing changes in the equation when lambda = 0?",
        "explain why nothing changes in this equation",
        "right ventricular pressure is 25 mmHg",
        "what is that symbol?",
        "really explain the second theorem",
        "I see a force of 20 N in the diagram",
        "forget the previous formula and solve this equation",
    ],
)
def test_social_detector_does_not_steal_academic_turns(question: str) -> None:
    from app.services.answer_intent import is_non_academic_chitchat

    assert not is_non_academic_chitchat(question)


def test_casual_replies_are_brief_and_natural() -> None:
    from app.services.answer_intent import chitchat_answer

    assert chitchat_answer("hhh") == "Haha 😄"
    assert chitchat_answer("I was just laughing") == "Got you 😄"
    assert chitchat_answer("nothing that concerns you") == "Fair enough."


@pytest.mark.parametrize("question", ["what?", "huh?", "why?", "really?"])
def test_ambiguous_short_followups_are_left_for_history_aware_routing(question: str) -> None:
    from app.services.answer_intent import is_non_academic_chitchat

    assert not is_non_academic_chitchat(question)


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
def test_resolved_task_family_beats_raw_followup_text() -> None:
    from types import SimpleNamespace
    from app.services.answer_intent import AcademicIntent, academic_intent_from_turn
    from app.services.dialogue_state import TaskFamily

    flashcards = SimpleNamespace(task_family=TaskFamily.FLASHCARDS, resolved_request="same for screws")
    exam = SimpleNamespace(task_family=TaskFamily.EXAMFORGE, resolved_request="sure")
    assert academic_intent_from_turn(flashcards, "same for screws") is AcademicIntent.FLASHCARD_GENERATION
    assert academic_intent_from_turn(exam, "sure") is AcademicIntent.EXAM_GENERATION


# --- P1 regression: negation-aware task detection -------------------------
#
# Production bug: "Explain the concept on this page in detail. Do not
# summarize it." classified as AcademicIntent.COURSE_SUMMARY because
# _SUMMARY_RE matched the word "summarize" inside the student's own
# PROHIBITION, with zero negation awareness — before this fix, every case
# below marked NEGATION FIX was AcademicIntent.COURSE_SUMMARY or
# QUIZ_GENERATION instead of CONCEPTUAL_EXPLANATION.
@pytest.mark.parametrize(
    ("question", "intent"),
    [
        # The exact confirmed production repro (BWL_gesamt page 6).
        ("Explain the concept on this page in detail. Do not summarize it.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Explain in detail; don't give me a summary.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Explain this chapter; don't quiz me.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Why did you summarize that?", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Give me a hint; do not solve it.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Erkläre diese Seite ausführlich, nicht zusammenfassen.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Bitte keine Zusammenfassung, sondern eine genaue Erklärung.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Nicht abfragen, sondern erklären.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Warum hast du das zusammengefasst?", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Explain it, nicht zusammenfassen.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        ("Erklär es bitte, don't summarize.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        # Genuine positive requests must still route correctly (no overcorrection).
        ("Summarize this page.", AcademicIntent.COURSE_SUMMARY),
        ("Quiz me on this chapter.", AcademicIntent.QUIZ_GENERATION),
        ("Fasse diese Seite zusammen.", AcademicIntent.COURSE_SUMMARY),
        ("Frag mich ab.", AcademicIntent.QUIZ_GENERATION),
        # Caught by independent review before merge, not by the acceptance
        # protocol above — kept here so they can't silently regress.
        # (1) German separable-verb negation ("fasse ... nicht zusammen") was
        # matched as a positive request by _SUMMARY_RE's new split-verb
        # branch, but not recognised by the negation guard.
        ("Fasse das bitte nicht zusammen, erkläre es stattdessen ausführlich.", AcademicIntent.CONCEPTUAL_EXPLANATION),
        # (2) a genuine, politely-phrased summary request must not be read as
        # a prohibition merely because it contains "don't".
        ("Why don't you summarize the key points for me?", AcademicIntent.COURSE_SUMMARY),
    ],
)
def test_negation_aware_task_detection(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


def test_unrelated_fasse_zusammen_cooccurrence_does_not_misfire() -> None:
    """(3) widening the German separable-verb match from an exact adjacent
    phrase to a 20-char gap risks false positives where 'fasse' (grab/hold)
    and 'zusammen' (together) are unrelated words, not the verb
    'zusammenfassen'. Must not route to COURSE_SUMMARY."""
    text = "Ich fasse die Unterlagen und lege sie zusammen mit dem Hefter weg."
    assert classify_academic_intent(text) != AcademicIntent.COURSE_SUMMARY


# AB-24 (semantic-intent blind A/B eval, 2026-10-20): "Frag mich die
# Lagerkraft R_A ab." (quiz me on the support force R_A) leaked the answer
# in BOTH the old and new pipeline, because _QUIZ_RE's separable-verb branch
# only matched the literal, adjacent "frag(e/en)? mich ab" — any real direct
# object between "frag"/"mich"/"ab" (which is how the separable verb
# "abfragen" is actually used) fell through to ordinary Q&A instead of the
# inline-quiz path that withholds the answer until the student attempts it.
@pytest.mark.parametrize(
    ("question", "intent"),
    [
        ("Frag mich die Lagerkraft R_A ab.", AcademicIntent.QUIZ_GENERATION),
        ("Fragst du mich die Kraft ab?", AcademicIntent.QUIZ_GENERATION),
        ("frag mich mal was zu dem Thema ab", AcademicIntent.QUIZ_GENERATION),
        # Negated separable-verb form must still suppress quiz routing.
        ("Frag mich das bitte nicht ab, erklär's mir einfach.", AcademicIntent.CONCEPTUAL_EXPLANATION),
    ],
)
def test_separable_verb_quiz_request_with_object(question: str, intent: AcademicIntent) -> None:
    assert classify_academic_intent(question) == intent


def test_unrelated_frage_mich_ab_wann_does_not_misfire() -> None:
    """Widening the 'frag ... mich ... ab' gap must not catch the unrelated
    idiom 'Ich frage mich, ab wann ...' (I wonder from when ...), where a
    comma breaks the clause between 'mich' and 'ab'."""
    text = "Ich frage mich, ab wann diese Regel gilt."
    assert classify_academic_intent(text) != AcademicIntent.QUIZ_GENERATION


# --- Second review pass (final verification request), fresh-context review ---
# caught 4 more real bugs before anything was merged. All fixed; locked in here.
@pytest.mark.parametrize(
    "question",
    [
        # (1) _NO_QUIZ_RE required tight adjacency; loosened to match
        # NEGATED_SUMMARY_RE's gapped style.
        "please don't turn this into a quiz",
        "I don't want to be quizzed on this, just explain",
        # (2) bare "no" was never a recognised negation trigger at all.
        "No summary please, just explain the concept",
        "no quiz, just teach me this",
    ],
)
def test_loosened_negation_guards_no_longer_misroute_to_prohibited_task(question: str) -> None:
    intent = classify_academic_intent(question)
    assert intent not in (AcademicIntent.COURSE_SUMMARY, AcademicIntent.QUIZ_GENERATION)


@pytest.mark.parametrize("question, expected", [
    ("Do not rush. Summarize this page.", AcademicIntent.COURSE_SUMMARY),
    ("Do not guess; quiz me on this chapter.", AcademicIntent.QUIZ_GENERATION),
    ("Why don't you quiz me?", AcademicIntent.QUIZ_GENERATION),
])
def test_unrelated_negation_preserves_positive_task(question, expected) -> None:
    assert classify_academic_intent(question) == expected
    instruction = intent_style_instruction(expected, question)
    assert "explicitly prohibited" not in instruction
    assert "explicitly asked not to be quizzed" not in instruction


def test_summary_feedback_does_not_invent_a_prohibition() -> None:
    question = "Why did you summarize that?"
    intent = classify_academic_intent(question)
    assert intent != AcademicIntent.COURSE_SUMMARY
    assert "explicitly prohibited" not in intent_style_instruction(intent, question)


def test_bare_no_at_a_distance_does_not_false_positive() -> None:
    """The tight bigram form for bare "no" ("no summary"/"no quiz") must not
    fire when "no" negates something else entirely, several words before a
    genuine positive summarize/quiz request later in the same sentence."""
    text = "No, I mean summarize the whole document, not just page 3."
    assert classify_academic_intent(text) == AcademicIntent.COURSE_SUMMARY


def test_prohibited_summary_adds_explicit_no_summary_instruction() -> None:
    """The central answer-generation fix (Section 7): a detected prohibition
    must reach the model as an explicit instruction, independent of which
    intent the request falls through to — not merely avoid the wrong intent."""
    from app.services.answer_intent import intent_style_instruction

    question = "Explain the concept on this page in detail. Do not summarize it."
    intent = classify_academic_intent(question)
    assert intent == AcademicIntent.CONCEPTUAL_EXPLANATION

    instruction = intent_style_instruction(intent, question)
    assert "prohibited summarizing" in instruction
    assert "Do NOT include a" in instruction


def test_prohibited_quiz_adds_explicit_no_quiz_instruction() -> None:
    from app.services.answer_intent import intent_style_instruction

    question = "Explain this chapter; don't quiz me."
    intent = classify_academic_intent(question)
    instruction = intent_style_instruction(intent, question)
    assert "explicitly asked not to be quizzed" in instruction


def test_unprohibited_requests_get_no_prohibition_instruction() -> None:
    """A plain explain/summarize request must not pick up either prohibition
    line — the instruction is only added when negation was actually detected."""
    from app.services.answer_intent import intent_style_instruction

    explain_only = "Explain this concept."
    instruction = intent_style_instruction(classify_academic_intent(explain_only), explain_only)
    assert "prohibited summarizing" not in instruction
    assert "explicitly asked not to be quizzed" not in instruction

    summarize_only = "Summarize this page."
    instruction = intent_style_instruction(classify_academic_intent(summarize_only), summarize_only)
    assert "prohibited summarizing" not in instruction


# ── final_negation_reminder (PR #27 follow-up) ──────────────────────────────
#
# Live production acceptance testing on the BWL page-6 request found that
# intent_style_instruction's prohibition line alone was not enough: the model
# still closed with a "Summary of ..." heading in 3/3 runs. final_negation_
# reminder is a second, more specific, maximally-positioned reminder for the
# SAME already-detected prohibition — these tests cover its own behaviour in
# isolation; test_answer_stream.py covers where callers place its output.

def test_final_negation_reminder_fires_on_the_live_repro_question() -> None:
    from app.services.answer_intent import final_negation_reminder

    question = "Explain the concept on this page in detail. Do not summarize it."
    reminder = final_negation_reminder(question)
    assert "FINAL REMINDER" in reminder
    # Must close the near-miss gap the live test exposed: the model satisfied
    # the earlier instruction's literal wording with a differently-titled
    # heading ("Summary of Development") rather than a bare "Summary".
    assert "Summary of" in reminder
    assert "Recap" in reminder
    assert "Takeaways" in reminder
    assert "Conclusion" in reminder


def test_final_negation_reminder_works_in_german() -> None:
    from app.services.answer_intent import final_negation_reminder

    question = "Erkläre das Konzept auf dieser Seite im Detail. Fasse es nicht zusammen."
    reminder = final_negation_reminder(question)
    assert "FINAL REMINDER" in reminder
    assert "Zusammenfassung" in reminder
    assert "Zusammenfassend" in reminder


@pytest.mark.parametrize("question", [
    "Explain the concept on this page in detail.",
    "Summarize the concept on this page briefly.",
    "Summarize this page.",
    "Quiz me on this chapter.",
    "Don't quiz me on this, just explain it.",
])
def test_final_negation_reminder_is_empty_without_a_summary_prohibition(question: str) -> None:
    """Scoped narrowly: only an explicit no-summary request gets the extra
    reminder. A plain explain, a plain (permitted) summarize request, and a
    quiz-only negation (no summary prohibition) must all get nothing —
    this must never become a blanket anti-summary/anti-conclusion rule."""
    from app.services.answer_intent import final_negation_reminder

    assert final_negation_reminder(question) == ""


def test_final_negation_user_reminder_fires_on_the_live_repro_question() -> None:
    from app.services.answer_intent import final_negation_user_reminder

    question = "Explain the concept on this page in detail. Do not summarize it."
    reminder = final_negation_user_reminder(question)
    assert "FINAL NO-SUMMARY CHECK" in reminder


@pytest.mark.parametrize("question", [
    "Explain the concept on this page in detail.",
    "Summarize the concept on this page briefly.",
    "Quiz me on this chapter.",
])
def test_final_negation_user_reminder_is_empty_without_a_summary_prohibition(question: str) -> None:
    from app.services.answer_intent import final_negation_user_reminder

    assert final_negation_user_reminder(question) == ""


@pytest.mark.parametrize(
    "question",
    [
        # Page-heading contamination (Section 9): a literal "Summary" /
        # "Zusammenfassung" heading elsewhere in the retrieved source text
        # must never itself route an explicit explain request to
        # COURSE_SUMMARY — classify_academic_intent only ever sees the raw
        # student question (fixed in PR #26 / commit 6a961b2f), not a copy
        # blended with page text, so a heading appearing in page_text alone
        # cannot reach this classifier at all.
        "Explain the concept on this page in detail. Do not summarize it.",
    ],
)
def test_page_heading_text_is_not_passed_to_classifier(question: str) -> None:
    # classify_academic_intent takes ONLY the student's question (plus
    # optional chunks/metadata for math-context signals) — simulating a page
    # whose own text contains "Zusammenfassung" by definition cannot affect
    # this call, because that text is never part of `question`. This test
    # documents and locks in that architectural guarantee.
    page_text_with_summary_heading = "## Zusammenfassung\nWirtschaft kommt von wirt und oikos..."
    assert page_text_with_summary_heading not in question
    assert classify_academic_intent(question) == AcademicIntent.CONCEPTUAL_EXPLANATION

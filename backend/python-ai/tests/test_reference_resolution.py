from __future__ import annotations

from app.services.reference_resolution import (
    decide_evidence,
    exact_question_label_match,
    normalize_question_label,
    resolve_language_context,
    resolve_question_reference,
)


def _resolve(question: str, visible_text: str = "", *, image: bool = True):
    return resolve_question_reference(
        question=question,
        course_id="course-a",
        active_document_id="doc-exam",
        active_document_name="exam.pdf",
        visible_page=33,
        selected_text=None,
        selected_region_id=None,
        visible_text=visible_text,
        has_visible_image=image,
    )


def test_question_labels_are_exact_not_substrings() -> None:
    assert normalize_question_label("Aufgabe 11") == "11"
    assert normalize_question_label("Question 1b:") == "1b"
    assert normalize_question_label("13,11") == "13.11"
    assert exact_question_label_match("11", "Aufgabe 11")
    assert not exact_question_label_match("11", "Aufgabe 13.11")
    assert not exact_question_label_match("1b", "Aufgabe 11b")


def test_identifier_format_variants_normalize_without_fuzzy_ocr_repair() -> None:
    for value in ("1b", "1 b", "1.b", "1(b)", "question 1(b)", "ex 1 b"):
        assert normalize_question_label(value) == "1b"
    assert normalize_question_label("01") == "1"
    for uncertain in ("1l", "I1", "l1"):
        assert normalize_question_label(uncertain) is None


def test_mark_11_is_not_reinterpreted_as_question_13_11() -> None:
    ref = _resolve(
        "No, the professor marked 11.",
        "Aufgabe 13.11\nTaylor equation\nCv = 580 × 10^3\nk = -1.80",
    )
    assert ref.mark_value == "11"
    assert ref.user_requested_label is None
    assert ref.resolved_question_number is None
    assert "13.11" in ref.candidate_labels
    assert ref.status == "resolved"  # the visible page is resolved, not Aufgabe 13.11
    decision = decide_evidence(ref, question="No, the professor marked 11.", has_history=True)
    assert decision.can_answer


def test_visual_reference_without_page_evidence_is_stopped_before_generation() -> None:
    ref = resolve_question_reference(
        question="Solve this.",
        course_id="course-a",
        active_document_id=None,
        active_document_name=None,
        visible_page=None,
        selected_text=None,
        selected_region_id=None,
        visible_text=None,
        has_visible_image=False,
    )
    decision = decide_evidence(ref, question="Solve this.", has_history=False)
    assert not decision.can_answer
    assert decision.action == "clarify"
    assert decision.recovery_code == "exact_question_not_resolved"


def test_exact_11_does_not_match_visible_13_11() -> None:
    ref = _resolve("Explain question 11.", "Aufgabe 13.11\nSome other problem", image=False)
    assert ref.user_requested_label == "11"
    assert ref.resolved_question_number is None
    assert ref.status == "not_found"


def test_language_context_is_independent_from_document_language() -> None:
    english = resolve_language_context(
        "Explain the marked question 11.",
        previous_turns=[],
        document_languages=["de"],
    )
    assert english.requested_response_language == "en"
    assert english.document_languages == ["de"]

    german = resolve_language_context(
        "Erkläre Aufgabe 1b.",
        previous_turns=[],
        document_languages=["en"],
    )
    assert german.requested_response_language == "de"

    french = resolve_language_context("Please answer in French.")
    assert french.requested_response_language == "fr"


def test_short_followup_retains_conversation_language() -> None:
    ctx = resolve_language_context(
        "why?",
        previous_turns=[
            {"role": "user", "text": "Explain the calculation in English."},
            {"role": "assistant", "text": "The first pass covers ten millimetres."},
        ],
        document_languages=["de"],
    )
    assert ctx.requested_response_language == "en"


def test_mixed_language_preserves_exact_identifier() -> None:
    ctx = resolve_language_context("Explain Aufgabe 11.")
    ref = _resolve("Explain Aufgabe 11.", "Aufgabe 11\nBerechnen Sie ...")
    assert ctx.code_switching_detected
    assert ctx.requested_response_language == "en"
    assert ref.resolved_question_number == "11"


def test_explicit_language_preference_is_sticky_across_followup() -> None:
    ctx = resolve_language_context(
        "now Aufgabe 12.3",
        previous_turns=[
            {"role": "user", "text": "Answer in English please."},
            {"role": "assistant", "text": "The verified result is 10."},
        ],
    )
    assert ctx.requested_response_language == "en"


def test_new_explicit_language_request_overrides_sticky_preference() -> None:
    ctx = resolve_language_context(
        "Answer in German please.",
        previous_turns=[
            {"role": "user", "text": "Answer in English please."},
            {"role": "assistant", "text": "The verified result is 10."},
        ],
    )
    assert ctx.requested_response_language == "de"

import pytest

from app.services.dialogue_state import DialogueAct, resolve_dialogue


def turns(*items):
    return [{"role": role, "text": text} for role, text in items]


def test_again_retries_the_failed_request_not_the_exam_overview():
    result = resolve_dialogue(
        "again",
        previous_turns=turns(
            ("user", "Solve Aufgabe 12.2 step by step."),
            ("assistant", "I am missing context."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.RETRY_PREVIOUS_REQUEST
    assert "Aufgabe 12.2" in result.resolved_request
    assert result.active_question == "12.2"
    assert result.requires_new_retrieval


def test_language_only_followup_transforms_previous_answer_without_retrieval():
    result = resolve_dialogue(
        "in English please",
        previous_turns=turns(
            ("user", "Warum ist es k+1?"),
            ("assistant", "Weil zwei Potenzen kombiniert werden."),
        ),
        response_language="de",
    )
    assert result.dialogue_act == DialogueAct.REQUEST_TRANSLATION
    assert result.response_language == "en"
    assert not result.requires_new_retrieval
    assert "immediately preceding" in result.resolved_request


def test_user_correction_invalidates_prior_answer_and_keeps_active_question():
    result = resolve_dialogue(
        "not the professor marked 11",
        previous_turns=turns(
            ("user", "How is Aufgabe 13.11 solved?"),
            ("assistant", "The professor marked 10."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.CORRECT_ASSISTANT
    assert result.active_question == "13.11"
    assert result.invalidate_previous_answer
    assert "exercise 13.11" in result.resolved_request


def test_explicit_corrected_question_number_outranks_old_reference():
    result = resolve_dialogue(
        "No, I mean Aufgabe 13.6",
        previous_turns=turns(
            ("user", "Explain Aufgabe 12.6"),
            ("assistant", "Aufgabe 12.6 is about tool life."),
        ),
        response_language="en",
    )
    assert result.active_question == "13.6"
    assert result.previous_question == "12.6"
    assert result.invalidate_previous_answer


def test_assistants_wrong_label_never_overrides_users_active_question():
    result = resolve_dialogue(
        "No, that is wrong.",
        previous_turns=turns(
            ("user", "Explain Aufgabe 13.6."),
            ("assistant", "Aufgabe 12.6 gives 15 seconds."),
        ),
        response_language="en",
    )
    assert result.active_question == "13.6"
    assert "exercise 13.6" in result.resolved_request


def test_bare_number_continues_same_workflow():
    result = resolve_dialogue(
        "now 12.2",
        previous_turns=turns(
            ("user", "Solve Aufgabe 12.1."),
            ("assistant", "The verified result is f = 0.15 mm/rev."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.CONTINUE_NEXT_QUESTION
    assert result.active_question == "12.2"
    assert "same tutoring workflow" in result.resolved_request


def test_confusion_changes_response_mode_and_tracks_repeated_attempts():
    result = resolve_dialogue(
        "I don't understand",
        previous_turns=turns(
            ("user", "Why is it k+1?"),
            ("assistant", "Here is the algebra."),
            ("user", "I don't understand"),
            ("assistant", "Here is another explanation."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.REQUEST_SIMPLIFICATION
    assert result.requested_depth == "first_time_learner"
    assert result.explanation_attempt >= 2
    assert "different teaching strategy" in result.resolved_request


def test_are_you_sure_triggers_fresh_verification():
    result = resolve_dialogue(
        "are you sure?",
        previous_turns=turns(
            ("user", "Solve Aufgabe 13.11."),
            ("assistant", "The answer is 10."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.VERIFY_PREVIOUS_ANSWER
    assert result.requires_new_retrieval
    assert "not rely on the previous assistant answer" in result.resolved_request


def test_all_means_solve_all_not_describe_topics():
    result = resolve_dialogue(
        "alle",
        previous_turns=turns(
            ("user", "Help me with Aufgabe 12."),
            ("assistant", "Which parts should I solve?"),
        ),
        response_language="de",
    )
    assert result.dialogue_act == DialogueAct.ANSWER_ALL_REQUESTED
    assert result.active_question == "12"
    assert "sequentially and completely" in result.resolved_request


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("Give me a hint", DialogueAct.REQUEST_HINT),
        ("overview please", DialogueAct.REQUEST_OVERVIEW),
        ("check my answer", DialogueAct.CHECK_ANSWER),
        ("only the result", DialogueAct.REQUEST_RESULT_ONLY),
        ("Give me only the first step", DialogueAct.REQUEST_FIRST_STEP),
        ("use the previous verified result", DialogueAct.REUSE_VERIFIED_RESULT),
    ],
)
def test_response_modes_are_structural(message, expected):
    result = resolve_dialogue(
        message,
        previous_turns=turns(
            ("user", "Solve Aufgabe 12.2."),
            ("assistant", "Here is the verified setup."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == expected


def test_continue_resumes_instead_of_restarting():
    result = resolve_dialogue(
        "Now continue from this line",
        previous_turns=turns(
            ("user", "Solve Aufgabe 12.2."),
            ("assistant", "First substitute f = 0.15 mm/rev."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.CONTINUE_FROM_STEP
    assert "Do not restart" in result.resolved_request


def test_mixed_confusion_targets_only_substitution():
    result = resolve_dialogue(
        "I understand the formula, but not the substitution.",
        previous_turns=turns(
            ("user", "Solve Aufgabe 12.2."),
            ("assistant", "Use n = vc/(pi*d)."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.REQUEST_SIMPLIFICATION
    assert result.requested_depth == "one_step"
    assert "only the substitution step" in result.resolved_request

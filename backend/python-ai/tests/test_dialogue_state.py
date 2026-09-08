import pytest

from app.services.dialogue_state import ConversationIntent, DialogueAct, resolve_dialogue


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


def test_explain_this_step_resolves_against_previous_answer():
    result = resolve_dialogue(
        "Explain this step in detail.",
        previous_turns=turns(
            ("user", "Solve Aufgabe 1b."),
            ("assistant", "Step 2: Θ_A = Θ_S + md²."),
        ),
        response_language="en",
    )
    assert result.dialogue_act == DialogueAct.REQUEST_MORE_DETAIL
    assert result.conversation_intent == ConversationIntent.FOLLOW_UP_EXPLANATION
    assert result.referent_type == "calculation_step"
    assert result.referent_text == "Step 2: Θ_A = Θ_S + md²."
    assert "unspecified" not in result.resolved_request
    assert "active source evidence" not in result.resolved_request
def test_bare_reaction_to_misrouted_pdf_reply_returns_to_general_conversation() -> None:
    result = resolve_dialogue(
        "what?",
        previous_turns=[
            {"role": "user", "text": "nothing that concerns you"},
            {
                "role": "assistant",
                "text": "I cannot reliably identify the marked question from the current page.",
            },
        ],
    )

    assert result.dialogue_act == DialogueAct.GENERAL_CONVERSATION
    assert not result.requires_new_retrieval


def test_bare_reaction_to_formula_answer_remains_academic_followup() -> None:
    result = resolve_dialogue(
        "what?",
        previous_turns=[
            {"role": "user", "text": "Explain torsional stress."},
            {"role": "assistant", "text": "In this formula τ = Mt / Wt."},
        ],
    )

    assert result.dialogue_act == DialogueAct.ASK_ABOUT_PREVIOUS_STEP
    assert result.requires_new_retrieval
@pytest.mark.parametrize("message", [
    "I have no clue", "can't decide", "you choose", "whatever you think",
    "your choice", "go ahead", "do it", "something else", "the second one",
])
def test_ambiguous_reply_families_request_semantic_resolution(message: str) -> None:
    from app.services.dialogue_state import needs_semantic_resolution, resolve_dialogue

    turns = [
        {"role": "assistant", "text": "Would you like statics or dynamics?"},
    ]
    resolution = resolve_dialogue(message, previous_turns=turns)
    assert needs_semantic_resolution(message, resolution, turns)


def test_explicit_new_topic_does_not_pay_semantic_fallback_or_inherit() -> None:
    from app.services.dialogue_state import TurnRelation, needs_semantic_resolution, resolve_dialogue

    turns = [
        {"role": "user", "text": "Explain welding from my course."},
        {"role": "assistant", "text": "Welding joins materials."},
    ]
    resolution = resolve_dialogue("What is the capital of Italy?", previous_turns=turns)
    assert resolution.relation is TurnRelation.NEW_TOPIC
    assert not needs_semantic_resolution("What is the capital of Italy?", resolution, turns)


def test_task_family_is_inherited_independently_from_relation() -> None:
    from app.services.dialogue_state import TaskFamily, resolve_dialogue

    turns = [
        {"role": "user", "text": "Calculate the torsional stress from my lecture."},
        {"role": "assistant", "text": "Using the course formula, the result is 20 MPa."},
    ]
    resolution = resolve_dialogue("why?", previous_turns=turns)
    assert resolution.task_family is TaskFamily.CALCULATE


def test_semantic_resolver_failure_preserves_safe_continuity(monkeypatch) -> None:
    from app.services import openai_client
    from app.services.dialogue_state import (
        TaskFamily, TurnRelation, resolve_dialogue, resolve_dialogue_semantically,
    )

    turns = [
        {"role": "user", "text": "Create flashcards about bearings."},
        {"role": "assistant", "text": "Should I make the same set for screws?"},
    ]
    base = resolve_dialogue("go ahead", previous_turns=turns)
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    resolved = resolve_dialogue_semantically("go ahead", previous_turns=turns, base=base)
    assert resolved.relation is TurnRelation.ANSWER_TO_ASSISTANT
    assert resolved.task_family is TaskFamily.FLASHCARDS
    assert resolved.continues_previous_goal

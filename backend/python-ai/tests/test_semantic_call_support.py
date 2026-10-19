"""Tests for ``app/services/semantic_call_support.py`` — the widened
escalation trigger and the model-output validator for the (future,
Milestone 3) multi-action semantic call. Pure functions, zero network.
"""

from app.services.resolved_student_intent import Action, ReleaseConstraints
from app.services.semantic_call_support import needs_semantic_escalation, validate_semantic_action


# ---------------------------------------------------------------------------
# Widened escalation trigger — these only decide WHETHER to call the model,
# never the classification itself (see case B, where the trigger correctly
# over-fires but the actual decision still ends up "permitted").
# ---------------------------------------------------------------------------

def test_negation_in_english_triggers_escalation():
    assert needs_semantic_escalation("Don't show me the final answer.") is True


def test_negation_in_german_triggers_escalation():
    assert needs_semantic_escalation("Keine Lösung für Aufgabe 5.") is True


def test_case_b_message_triggers_escalation_even_though_not_a_real_prohibition():
    assert needs_semantic_escalation("Ich weiß die Lösung nicht. Kannst du sie mir zeigen?") is True


def test_quoted_reported_speech_triggers_escalation():
    assert needs_semantic_escalation("The professor wrote: 'Show the full solution.'") is True


def test_correction_language_triggers_escalation():
    assert needs_semantic_escalation("Actually, I meant Aufgabe 5b, not 5a.") is True


def test_two_exercise_labels_trigger_escalation_as_multi_target():
    assert needs_semantic_escalation("Aufgabe 5 keine Lösung, Aufgabe 6 volle Lösung.") is True


def test_unresolved_reference_flag_triggers_escalation():
    assert needs_semantic_escalation("Explain this to me.", has_unresolved_reference=True) is True


def test_plain_unambiguous_question_does_not_trigger_escalation():
    assert needs_semantic_escalation("What is the formula for torsion?") is False


def test_release_word_alone_without_any_other_cue_does_not_trigger():
    assert needs_semantic_escalation("Show me the solution.") is False


# ---------------------------------------------------------------------------
# Output validation for one model-proposed action.
# ---------------------------------------------------------------------------

def _valid_payload(**overrides):
    payload = {
        "objective": "solve", "target": "5", "confidence": 0.9,
        "release": {"final_answer": "permitted"},
    }
    payload.update(overrides)
    return payload


def test_valid_payload_is_accepted():
    action = validate_semantic_action(_valid_payload())
    assert action is not None
    assert action.objective == "solve"
    assert action.release.final_answer == "permitted"


def test_unknown_objective_rejected():
    assert validate_semantic_action(_valid_payload(objective="not_a_real_objective")) is None


def test_missing_target_rejected():
    payload = _valid_payload()
    del payload["target"]
    assert validate_semantic_action(payload) is None


def test_out_of_range_confidence_rejected():
    assert validate_semantic_action(_valid_payload(confidence=1.5)) is None


def test_boolean_confidence_rejected():
    assert validate_semantic_action(_valid_payload(confidence=True)) is None


def test_below_floor_confidence_returns_none_not_an_exception():
    assert validate_semantic_action(_valid_payload(confidence=0.2)) is None


def test_unknown_release_enum_value_rejected():
    payload = _valid_payload(release={"final_answer": "maybe"})
    assert validate_semantic_action(payload) is None


def test_non_int_max_steps_rejected():
    payload = _valid_payload(release={"final_answer": "permitted", "max_steps": "one"})
    assert validate_semantic_action(payload) is None


def test_model_may_add_a_prohibition_the_base_did_not_have():
    base = Action(objective="solve", target="5", release=ReleaseConstraints(final_answer="permitted"))
    action = validate_semantic_action(
        _valid_payload(release={"final_answer": "prohibited"}), base_action=base,
    )
    assert action is not None
    assert action.release.final_answer == "prohibited"


def test_model_can_never_remove_a_high_confidence_base_prohibition():
    base = Action(objective="solve", target="5", release=ReleaseConstraints(final_answer="prohibited"))
    action = validate_semantic_action(
        _valid_payload(release={"final_answer": "permitted"}), base_action=base,
    )
    assert action is None  # fail-closed: never silently expand what was already prohibited

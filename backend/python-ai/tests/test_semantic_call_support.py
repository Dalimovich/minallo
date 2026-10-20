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


# ===========================================================================
# Hardening pass (code review): target validation.
# ===========================================================================

def test_none_target_rejected():
    assert validate_semantic_action(_valid_payload(target=None)) is None


def test_empty_string_target_rejected():
    assert validate_semantic_action(_valid_payload(target="")) is None


def test_whitespace_only_target_rejected():
    assert validate_semantic_action(_valid_payload(target="   ")) is None


def test_non_string_target_rejected():
    assert validate_semantic_action(_valid_payload(target=5)) is None


def test_dict_target_rejected():
    assert validate_semantic_action(_valid_payload(target={"label": "5"})) is None


# ===========================================================================
# Hardening pass: action-state enum validation (previously unchecked).
# ===========================================================================

def test_unknown_action_state_rejected():
    assert validate_semantic_action(_valid_payload(state="maybe_prohibited")) is None


def test_known_action_state_accepted():
    action = validate_semantic_action(_valid_payload(state="prohibited"))
    assert action is not None
    assert action.state == "prohibited"


# ===========================================================================
# Hardening pass: unknown top-level and nested release fields rejected,
# not silently ignored.
# ===========================================================================

def test_unknown_top_level_field_rejected():
    payload = _valid_payload()
    payload["unexpected_field"] = "sneaky"
    assert validate_semantic_action(payload) is None


def test_unknown_nested_release_field_rejected():
    payload = _valid_payload(release={"final_answer": "permitted", "not_a_real_field": 1})
    assert validate_semantic_action(payload) is None


def test_model_cannot_set_changed_by_turn_directly():
    """changed_by_turn names a TRUSTED, deterministic turn — a model
    payload is never in a position to make that claim on its own, so it
    is rejected as an unknown field rather than silently accepted (and
    then wrongly trusted as a verified turn marker downstream)."""
    payload = _valid_payload(release={"final_answer": "permitted", "changed_by_turn": "turn-5"})
    assert validate_semantic_action(payload) is None


# ===========================================================================
# Hardening pass: max_steps/max_items range checking (previously type-only).
# ===========================================================================

def test_zero_max_steps_rejected():
    assert validate_semantic_action(_valid_payload(release={"max_steps": 0})) is None


def test_negative_max_steps_rejected():
    assert validate_semantic_action(_valid_payload(release={"max_steps": -3})) is None


def test_unreasonably_large_max_items_rejected():
    assert validate_semantic_action(_valid_payload(release={"max_items": 10_000})) is None


def test_reasonable_max_steps_accepted():
    action = validate_semantic_action(_valid_payload(release={"max_steps": 3}))
    assert action is not None
    assert action.release.max_steps == 3


# ===========================================================================
# Hardening pass: malformed nested release values must never raise —
# fail-closed even on a type the old code's except clause didn't catch.
# ===========================================================================

def test_non_dict_release_string_does_not_raise():
    assert validate_semantic_action(_valid_payload(release="not_a_dict")) is None


def test_non_dict_release_list_does_not_raise():
    assert validate_semantic_action(_valid_payload(release=["final_answer", "permitted"])) is None


# ===========================================================================
# Hardening pass: prohibition preservation across EVERY release dimension,
# not just final_answer/official_solution.
# ===========================================================================

def test_model_cannot_loosen_a_trusted_explanation_depth_restriction():
    base = Action(objective="review_student_solution", target="5", release=ReleaseConstraints(explanation_depth="none"))
    action = validate_semantic_action(
        _valid_payload(objective="review_student_solution", release={"explanation_depth": "worked_derivation"}),
        base_action=base,
    )
    assert action is None


def test_model_cannot_loosen_a_trusted_form_restriction():
    base = Action(objective="hint", target="5", release=ReleaseConstraints(form="hint"))
    action = validate_semantic_action(
        _valid_payload(objective="hint", release={"form": "worked_solution"}), base_action=base,
    )
    assert action is None


def test_model_cannot_loosen_a_trusted_max_steps_cap():
    base = Action(objective="hint", target="5", release=ReleaseConstraints(max_steps=1))
    action = validate_semantic_action(
        _valid_payload(objective="hint", release={"max_steps": 10}), base_action=base,
    )
    assert action is None


def test_model_cannot_loosen_a_trusted_wait_for_student_flag():
    base = Action(objective="hint", target="5", release=ReleaseConstraints(wait_for_student=True))
    action = validate_semantic_action(
        _valid_payload(objective="hint", release={"wait_for_student": False}), base_action=base,
    )
    assert action is None


def test_model_can_tighten_a_trusted_max_steps_cap():
    base = Action(objective="hint", target="5", release=ReleaseConstraints(max_steps=5))
    action = validate_semantic_action(
        _valid_payload(objective="hint", release={"max_steps": 1}), base_action=base,
    )
    assert action is not None
    assert action.release.max_steps == 1


# ===========================================================================
# Hardening pass: the platform-policy consistency check promised in the
# module docstring but previously absent from the function signature.
# ===========================================================================

def test_model_cannot_loosen_past_a_platform_forbidden_floor():
    action = validate_semantic_action(
        _valid_payload(release={"official_solution": "permitted"}),
        platform_forbidden={"official_solution": "prohibited"},
    )
    assert action is None


def test_platform_forbidden_does_not_reject_an_already_compliant_value():
    action = validate_semantic_action(
        _valid_payload(release={"official_solution": "prohibited"}),
        platform_forbidden={"official_solution": "prohibited"},
    )
    assert action is not None


# ===========================================================================
# Hardening pass: the model may propose its own `prohibited` objectives,
# validated the same way as `objective` itself.
# ===========================================================================

def test_model_proposed_prohibited_objectives_validated():
    action = validate_semantic_action(_valid_payload(prohibited=["official_solution"]))
    assert action is not None
    assert action.prohibited == ("official_solution",)


def test_model_proposed_prohibited_with_unknown_objective_rejected():
    assert validate_semantic_action(_valid_payload(prohibited=["not_a_real_objective"])) is None

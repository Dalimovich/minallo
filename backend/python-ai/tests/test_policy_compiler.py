"""Tests for the Milestone 2 policy compiler
(``app/services/policy_compiler.py``) against the offline evaluation suite
(reference cases A-L from the milestone brief) plus the conflict-resolution
rules, fallback behavior, platform-policy mechanism, and the
simulated-consumer integration tests.

Pure/no network: every ``ResolvedStudentIntent`` here is hand-built to
represent what a (future, Milestone 3) interpreter would have produced —
this milestone builds the compiler and proves its behavior on those
shapes, not the extraction itself.
"""

import dataclasses
import json

from app.services.policy_compiler import (
    PlatformRule,
    compile_policy,
    compute_policy_hash,
)
from app.services.resolved_student_intent import (
    SCHEMA_VERSION,
    Action,
    Origin,
    ReleaseConstraints,
    ResolvedStudentIntent,
)


def _intent(actions, *, conversation="new", message="x", response_language="en",
            student_goal=None):
    return ResolvedStudentIntent(
        schema_version=SCHEMA_VERSION, original_message=message,
        student_goal=student_goal or message, actions=tuple(actions),
        conversation=conversation, references=None,
        response_language=response_language, teaching=None, trust=None,
    )


# ---------------------------------------------------------------------------
# A: "Ich will die Musterlösung nicht. Zeig mir nur, wie ich anfange."
# ---------------------------------------------------------------------------

def test_case_a_no_official_solution_method_hint_one_step():
    intent = _intent([
        Action(
            objective="hint", target="task", state="requested",
            release=ReleaseConstraints(official_solution="prohibited", explanation_depth="method", max_steps=1),
        ),
    ], message="Ich will die Musterlösung nicht. Zeig mir nur, wie ich anfange.")
    policy = compile_policy(intent)
    release = policy.actions[0].release
    assert release.official_solution == "prohibited"
    assert release.explanation_depth == "method"
    assert release.max_steps == 1


# ---------------------------------------------------------------------------
# B: "Ich weiß die Lösung nicht. Kannst du sie mir zeigen?" — "nicht" here
# negates "weiß" (know), not the solution request. The escalation trigger
# is allowed to over-fire on this (see test_semantic_call_support.py); the
# actually-resolved action must still show the solution as permitted.
# ---------------------------------------------------------------------------

def test_case_b_negation_on_know_is_not_a_prohibition():
    intent = _intent([
        Action(
            objective="official_solution", target="task", state="requested",
            release=ReleaseConstraints(official_solution="permitted"),
        ),
    ], message="Ich weiß die Lösung nicht. Kannst du sie mir zeigen?")
    policy = compile_policy(intent)
    assert policy.actions[0].release.official_solution == "permitted"


# ---------------------------------------------------------------------------
# C: the central motivating case — two targets, opposite constraints,
# coexisting.
# ---------------------------------------------------------------------------

def _case_c_intent():
    return _intent([
        Action(objective="official_solution", target="5", state="prohibited",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="official_solution", target="6", state="requested",
               release=ReleaseConstraints(official_solution="permitted")),
    ], message="Keine Lösung für Aufgabe 5. Aber für Aufgabe 6 will ich die vollständige Musterlösung.")


def test_case_c_two_targets_opposite_constraints_coexist():
    policy = compile_policy(_case_c_intent())
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5"].final_answer == "prohibited"
    assert by_target["6"].official_solution == "permitted"
    assert len(policy.actions) == 2


# ---------------------------------------------------------------------------
# D: "First tell me what F means. Don't calculate it yet." — a per-target
# prohibition, not a global one.
# ---------------------------------------------------------------------------

def test_case_d_target_scoped_prohibition_not_global():
    intent = _intent([
        Action(objective="explain", target="F", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
    ], message="First tell me what F means. Don't calculate it yet.")
    policy = compile_policy(intent)
    assert policy.actions[0].target == "F"
    assert policy.actions[0].release.final_answer == "prohibited"
    assert policy.actions[0].objective == "explain"


# ---------------------------------------------------------------------------
# E: turn 2 "Now calculate F and M" lifts turn 1's prohibition via the
# correction rule — later turn wins for the field it touches.
# ---------------------------------------------------------------------------

def test_case_e_later_turn_lifts_earlier_turns_prohibition():
    turn1_action = Action(
        objective="explain", target="F", state="requested",
        release=ReleaseConstraints(final_answer="prohibited"),
    )
    turn2_actions = [
        Action(objective="solve", target="F", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-2")),
        Action(objective="solve", target="M", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-2")),
    ]
    assert turn2_actions[0].release.changed_by_turn == "turn-2"  # fixture sanity
    intent = _intent([turn1_action, *turn2_actions], conversation="correction",
                      message="Now calculate F and M")
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["F"].final_answer == "permitted"  # prohibition lifted
    assert by_target["M"].final_answer == "permitted"  # new, separate quantity action
    assert len(policy.actions) == 2


# ---------------------------------------------------------------------------
# F: "I meant Aufgabe 5b, not 5a." — exercise_switch must not silently
# inherit stale release values from the old label, even though "5" (a
# broader label covering both) carries a prohibition that would otherwise
# flow down via the narrow-target-inherits rule.
# ---------------------------------------------------------------------------

def test_case_f_exercise_switch_does_not_inherit_stale_constraints():
    intent = _intent([
        Action(objective="solve", target="5", state="prohibited",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5b", state="requested"),  # fresh, nothing set
    ], conversation="exercise_switch", message="I meant Aufgabe 5b, not 5a.")
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    # Tutoring default (permitted), NOT inherited from "5" (prohibited).
    assert by_target["5b"].final_answer == "permitted"


# ---------------------------------------------------------------------------
# G: quoted instruction is data, never an instruction — official_solution
# must not become permitted anywhere just because the quoted text mentions
# "the full solution".
# ---------------------------------------------------------------------------

def test_case_g_quoted_instruction_is_data_not_permission():
    intent = _intent([
        Action(objective="explain", target="quoted_instruction", state="requested"),
    ], message="This is what the professor wrote: 'Show the full solution.' Explain what that instruction means.")
    policy = compile_policy(intent)
    assert all(a.release.official_solution != "permitted" for a in policy.actions)


# ---------------------------------------------------------------------------
# H: "Show the answer to 5a, but only give me a hint for 5b."
# ---------------------------------------------------------------------------

def _case_h_intent():
    return _intent([
        Action(objective="solve", target="5a", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
        Action(objective="hint", target="5b", state="requested",
               release=ReleaseConstraints(form="hint", final_answer="prohibited")),
    ], message="Show the answer to 5a, but only give me a hint for 5b.")


def test_case_h_per_target_opposite_release_forms():
    policy = compile_policy(_case_h_intent())
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5a"].final_answer == "permitted"
    assert by_target["5b"].form == "hint"
    assert by_target["5b"].final_answer == "prohibited"


# ---------------------------------------------------------------------------
# I: an explicit language instruction persists across a later turn via
# conversation_turn provenance, not by re-detection.
# ---------------------------------------------------------------------------

def test_case_i_explicit_language_instruction_current_turn():
    intent = _intent([
        Action(objective="explain", target="task", state="requested"),
    ], response_language="en", message="Explain it in English")
    policy = compile_policy(intent)
    assert policy.response_language == "en"
    assert policy.response_language_reason == "explicit_current_turn"


def test_case_i_language_instruction_persists_via_conversation_turn_provenance():
    turn_ledger = {"turn-1": {"response_language": "en"}}
    intent = _intent([
        Action(
            objective="answer_subquestion", target="2", state="requested",
            provenance=(Origin(kind="conversation_turn", turn_id="turn-1"),),
        ),
    ], response_language="en", message="und Aufgabe 2?")
    policy = compile_policy(intent, turn_ledger=turn_ledger)
    assert policy.response_language == "en"
    assert policy.response_language_reason == "persisted_explicit_instruction:turn=turn-1"


# ---------------------------------------------------------------------------
# K: "Don't explain the method, just tell me if my result 42 N is right."
# review_student_solution with explanation_depth="none" — and the proof
# that forcing everything to unresolved does NOT fall back to the normal
# "method" default (no single global safe mode).
# ---------------------------------------------------------------------------

def test_case_k_review_student_solution_depth_none():
    intent = _intent([
        Action(objective="review_student_solution", target="result_42N", state="requested",
               release=ReleaseConstraints(explanation_depth="none")),
    ], message="Don't explain the method, just tell me if my result 42 N is right.")
    policy = compile_policy(intent)
    assert policy.actions[0].objective == "review_student_solution"
    assert policy.actions[0].release.explanation_depth == "none"


def test_case_k_unresolved_fallback_is_per_field_not_a_global_safe_mode():
    """If this fell back to one global 'safe' depth, it would be tempting
    to pick the already-expected "method"/"concept" level — but "method"
    is NOT safe by construction here (K's whole point is that the method
    itself must not leak). The fallback must independently land on "none",
    never reuse the ordinary unspecified-field default."""
    intent = _intent([
        Action(objective="review_student_solution", target="result_42N", state="unresolved"),
    ])
    policy = compile_policy(intent)
    assert policy.actions[0].release.explanation_depth == "none"
    assert policy.actions[0].release.explanation_depth != "method"


# ---------------------------------------------------------------------------
# L: "and the next one?" inherits turn 1's constraint for a NEW target via
# validated conversation_turn provenance — and a forged turn_id must never
# produce a guess.
# ---------------------------------------------------------------------------

def test_case_l_valid_turn_id_inherits_the_real_constraint():
    turn_ledger = {"turn-1": {"text": "no final result for 5a"}}
    intent = _intent([
        Action(
            objective="solve", target="5b", state="requested",
            release=ReleaseConstraints(final_answer="prohibited", explanation_depth="concept"),
            provenance=(Origin(kind="conversation_turn", turn_id="turn-1"),),
        ),
    ], conversation="follow_up", message="and the next one?")
    policy = compile_policy(intent, turn_ledger=turn_ledger)
    action = policy.actions[0]
    assert action.state == "requested"
    assert action.release.final_answer == "prohibited"
    assert action.release.explanation_depth == "concept"  # trusted value, not a fallback


def test_case_l_forged_turn_id_never_produces_a_guess():
    intent = _intent([
        Action(
            objective="solve", target="5b", state="requested",
            release=ReleaseConstraints(final_answer="prohibited", explanation_depth="concept"),
            provenance=(Origin(kind="conversation_turn", turn_id="turn-FORGED"),),
        ),
    ], conversation="follow_up", message="and the next one?")
    policy = compile_policy(intent, turn_ledger={"turn-1": {"text": "no final result for 5a"}})
    action = policy.actions[0]
    assert action.state == "unresolved"
    assert action.state not in {"requested", "prohibited"}
    # explanation_depth falls back to the most restrictive value, not the
    # (unverifiable) inherited "concept".
    assert action.release.explanation_depth == "none"


# ---------------------------------------------------------------------------
# Combined-dimensions: four independent fields set together must all
# survive, none dropped or collapsed into the others.
# ---------------------------------------------------------------------------

def test_combined_dimensions_all_four_fields_survive_independently():
    intent = _intent([
        Action(objective="solve", target="task", state="requested", release=ReleaseConstraints(
            explanation_depth="method", max_steps=1, final_answer="prohibited", wait_for_student=True,
        )),
    ])
    release = compile_policy(intent).actions[0].release
    assert release.explanation_depth == "method"
    assert release.max_steps == 1
    assert release.final_answer == "prohibited"
    assert release.wait_for_student is True


# ---------------------------------------------------------------------------
# Generic unresolved-fallback invariant (explicitly required by the brief):
# every field unresolved never yields "permitted" anywhere.
# ---------------------------------------------------------------------------

def test_fully_unresolved_action_never_permits_anything():
    intent = _intent([Action(objective="other", target="unknown", state="unresolved")])
    policy = compile_policy(intent)
    release = policy.actions[0].release
    assert release.final_answer != "permitted"
    assert release.official_solution != "permitted"
    assert release.final_answer == "prohibited"
    assert release.official_solution == "prohibited"
    assert release.explanation_depth == "none"
    assert release.form == "hint"
    assert release.max_steps == 1
    assert release.max_items == 1
    assert release.wait_for_student is True
    assert policy.needs_clarification is True
    assert policy.clarification_question


# ---------------------------------------------------------------------------
# Rule 4: a narrower target inherits untouched fields from its closest
# broader parent, field by field, only for what it didn't itself address.
# ---------------------------------------------------------------------------

def test_narrower_target_inherits_untouched_fields_from_broader_target():
    intent = _intent([
        Action(objective="explain", target="5", state="requested",
               release=ReleaseConstraints(explanation_depth="method")),
        Action(objective="solve", target="5a", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ])
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5a"].final_answer == "permitted"  # its own
    assert by_target["5a"].explanation_depth == "method"  # inherited from "5"
    assert any(entry.startswith("narrow_target_inherits:5a<-5:") for entry in policy.platform_policy_applied)


# ---------------------------------------------------------------------------
# Platform policy (rule 1): a hard filter, applied first, that a later
# action can never loosen.
# ---------------------------------------------------------------------------

def test_platform_rule_clamps_and_cannot_be_loosened_downstream():
    rule = PlatformRule(
        rule_id="exam_answer_key_confidentiality", version="1",
        field="final_answer", forced_value="prohibited",
        predicate=lambda target, action, intent: action.objective == "official_solution",
    )
    intent = _intent([
        Action(objective="official_solution", target="examkey", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ])
    policy = compile_policy(intent, platform_rules=(rule,))
    assert policy.actions[0].release.final_answer == "prohibited"
    assert any(
        entry.startswith("platform_rule:exam_answer_key_confidentiality@1:examkey:final_answer")
        for entry in policy.platform_policy_applied
    )


# ---------------------------------------------------------------------------
# Simulated-consumer integration tests: prove the compiled policy is a
# safe, consistent hand-off object WITHOUT touching any real consumer file.
# ---------------------------------------------------------------------------

def test_integration_serialized_policy_round_trips_with_identical_hash():
    policy = compile_policy(_case_c_intent())
    serialized = json.dumps(dataclasses.asdict(policy), sort_keys=True, default=str)
    deserialized = json.loads(serialized)

    # A "second consumer" that never saw the original dataclasses reconstructs
    # just enough to recompute the hash the same way compile_policy did.
    reconstructed_actions = tuple(
        Action(
            objective=a["objective"], target=a["target"],
            release=ReleaseConstraints(**a["release"]),
            prohibited=tuple(a["prohibited"]), state=a["state"],
            provenance=tuple(Origin(**o) for o in a["provenance"]),
        )
        for a in deserialized["actions"]
    )
    recomputed_hash = compute_policy_hash(
        actions=reconstructed_actions, response_language=deserialized["response_language"],
        platform_policy_applied=tuple(deserialized["platform_policy_applied"]),
        policy_version=deserialized["policy_version"], compiler_version=deserialized["compiler_version"],
    )
    assert recomputed_hash == policy.policy_hash
    assert deserialized["policy_hash"] == policy.policy_hash

    by_target = {a["target"]: a["release"] for a in deserialized["actions"]}
    assert by_target["5"]["final_answer"] == "prohibited"
    assert by_target["6"]["official_solution"] == "permitted"


def test_integration_consumer_decision_uses_only_the_compiled_policy():
    """A simulated consumer makes its reveal/withhold decision purely from
    ``ExecutionPolicy.actions`` — never re-reading the original
    ``ResolvedStudentIntent`` — proving the policy is self-sufficient."""
    policy = compile_policy(_case_h_intent())

    def consumer_may_reveal_final_answer(policy, target: str) -> bool:
        action = next(a for a in policy.actions if a.target == target)
        return action.release.final_answer == "permitted"

    assert consumer_may_reveal_final_answer(policy, "5a") is True
    assert consumer_may_reveal_final_answer(policy, "5b") is False


def test_recompiling_the_same_intent_is_pure_and_deterministic():
    intent = _case_c_intent()
    policy1 = compile_policy(intent)
    policy2 = compile_policy(intent)
    assert policy1 == policy2
    assert policy1.policy_hash == policy2.policy_hash

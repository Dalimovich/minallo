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
    TurnLedger,
)


def _ledger(turns, conversation_id="conv-1"):
    return TurnLedger.build(conversation_id=conversation_id, turns=turns)


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
    """Decision 2 hardening: a cross-turn correction now REQUIRES a
    verified turn_ledger — recency is never taken from raw list order.
    Both actions carry an explicit, ledger-verifiable changed_by_turn
    (turn 1's own action included — "no label" is reserved for the
    literal live/current turn, never for a historical one, exactly to
    avoid the ambiguity a bare sentinel would create here)."""
    turn1_action = Action(
        objective="explain", target="F", state="requested",
        release=ReleaseConstraints(final_answer="prohibited", changed_by_turn="turn-1"),
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
    ledger = _ledger({"turn-1": {}, "turn-2": {}})
    policy = compile_policy(intent, turn_ledger=ledger)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["F"].final_answer == "permitted"  # prohibition lifted
    assert by_target["M"].final_answer == "permitted"  # new, separate quantity action
    assert len(policy.actions) == 2
    assert policy.needs_clarification is False  # a verified correction needs no clarification


def test_case_e_without_a_verified_ledger_the_correction_is_not_trusted():
    """Same scenario, but with NO turn_ledger supplied at all: Decision 2
    forbids falling back to list order for a cross-turn claim, so the
    earlier, already-established prohibition must be preserved instead of
    silently lifted — and the target flagged for clarification."""
    turn1_action = Action(
        objective="explain", target="F", state="requested",
        release=ReleaseConstraints(final_answer="prohibited", changed_by_turn="turn-1"),
    )
    turn2_action = Action(
        objective="solve", target="F", state="requested",
        release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-2"),
    )
    intent = _intent([turn1_action, turn2_action], conversation="correction")
    policy = compile_policy(intent)  # no turn_ledger
    assert policy.actions[0].release.final_answer == "prohibited"  # preserved, not lifted
    assert policy.needs_clarification is True
    assert any(e.startswith("missing_required_history:F:final_answer") for e in policy.platform_policy_applied)


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
    turn_ledger = _ledger({"turn-1": {"response_language": "en"}})
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
    turn_ledger = _ledger({"turn-1": {"text": "no final result for 5a"}})
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
    policy = compile_policy(intent, turn_ledger=_ledger({"turn-1": {"text": "no final result for 5a"}}))
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
        evidence_requirements=tuple(deserialized["evidence_requirements"]),
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


# ===========================================================================
# Hardening pass (code review): trusted/untrusted action merging.
# ===========================================================================

def _trusted_explain(target="5"):
    return Action(objective="explain", target=target, state="requested")


def _untrusted_official_solution_attempt(target="5"):
    return Action(
        objective="official_solution", target=target, state="unresolved",
        release=ReleaseConstraints(final_answer="permitted"),
    )


def test_untrusted_action_never_determines_objective_or_state_trusted_first():
    intent = _intent([_trusted_explain(), _untrusted_official_solution_attempt()])
    policy = compile_policy(intent)
    action = policy.actions[0]
    assert action.objective == "explain"  # never "official_solution"
    assert action.state == "requested"  # the trusted explain stands, not blanket "unresolved"
    assert action.target == "5"


def test_untrusted_action_never_determines_objective_or_state_untrusted_first():
    """Same as above with insertion order reversed — the fix must not be
    order-dependent."""
    intent = _intent([_untrusted_official_solution_attempt(), _trusted_explain()])
    policy = compile_policy(intent)
    action = policy.actions[0]
    assert action.objective == "explain"
    assert action.state == "requested"


def test_untrusted_contested_field_never_gets_the_permissive_tutoring_default():
    """The untrusted action's own proposed value (final_answer=permitted)
    must not leak in, AND the field must not silently fall back to the
    ordinary tutoring default (also "permitted") either — both would look
    identical and wrongly permissive. It must land on the restrictive
    fallback specifically because an untrusted attempt touched it."""
    intent = _intent([_trusted_explain(), _untrusted_official_solution_attempt()])
    policy = compile_policy(intent)
    action = policy.actions[0]
    assert action.release.final_answer == "prohibited"
    assert any(
        entry.startswith("contested_fallback:5:final_answer=") for entry in policy.platform_policy_applied
    )
    assert policy.needs_clarification is True


def test_untrusted_attempted_objective_is_surfaced_not_silently_dropped():
    intent = _intent([_trusted_explain(), _untrusted_official_solution_attempt()])
    policy = compile_policy(intent)
    assert "official_solution" in policy.actions[0].prohibited


def test_trusted_fields_independently_established_survive_alongside_contested_ones():
    """A field a DIFFERENT trusted action legitimately set must not be
    swept into the restrictive fallback just because another, untrusted
    action also showed up for the same target."""
    intent = _intent([
        Action(objective="explain", target="5", state="requested",
               release=ReleaseConstraints(explanation_depth="method")),
        _untrusted_official_solution_attempt(),
    ])
    policy = compile_policy(intent)
    assert policy.actions[0].release.explanation_depth == "method"  # trusted, preserved
    assert policy.actions[0].release.final_answer == "prohibited"  # contested, restrictive


def test_distinguish_prohibiting_one_action_from_prohibiting_the_entire_target():
    """Two TRUSTED actions, same target, same turn: one objective
    explicitly prohibited, a different objective explicitly requested.
    The compiled target must reflect the requested objective as primary
    (not collapse the whole target to "prohibited"), while still
    recording the prohibited objective explicitly."""
    intent = _intent([
        Action(objective="official_solution", target="5", state="prohibited",
               release=ReleaseConstraints(official_solution="prohibited")),
        Action(objective="hint", target="5", state="requested",
               release=ReleaseConstraints(form="hint")),
    ])
    policy = compile_policy(intent)
    action = policy.actions[0]
    assert action.objective == "hint"
    assert action.state == "requested"
    assert "official_solution" in action.prohibited
    assert action.release.official_solution == "prohibited"  # the prohibition's own field still holds
    assert action.release.form == "hint"


def test_provenance_all_valid_required_not_any_valid(monkeypatch=None):
    """Regression for the provenance fix in resolved_student_intent.py: an
    action with ONE valid origin and ONE forged origin must downgrade to
    unresolved at compile time too (exercised through compile_policy, not
    just the unit-level validator)."""
    intent = _intent([
        Action(
            objective="solve", target="5b", state="requested",
            release=ReleaseConstraints(final_answer="permitted"),
            provenance=(
                Origin(kind="current_message", span=(0, 1)),
                Origin(kind="conversation_turn", turn_id="turn-forged"),
            ),
        ),
    ], message="x")
    policy = compile_policy(intent, turn_ledger=_ledger({"turn-1": {}}))
    assert policy.actions[0].state == "unresolved"
    assert policy.actions[0].release.final_answer == "prohibited"


# ===========================================================================
# Hardening pass: reliable conflict resolution (turn recency, same-turn
# correction vs. genuine ambiguity, forged/out-of-order turn metadata).
# ===========================================================================

def test_same_turn_explicit_correction_lets_the_later_clause_win():
    """"Don't show the result. Actually, show it." — both clauses are the
    SAME turn (no distinguishing marker), but conversation="correction"
    signals this is the student overriding themselves, so the later
    clause wins outright rather than the restrictive tie-break."""
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ], conversation="correction", message="Don't show the result. Actually, show it.")
    policy = compile_policy(intent)
    assert policy.actions[0].release.final_answer == "permitted"


def test_same_turn_genuine_ambiguity_without_correction_signal_stays_restrictive():
    """The same two conflicting actions WITHOUT conversation="correction"
    have no "which one is the correction" signal, so the safe restrictive
    tie-break applies instead."""
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ], conversation="new")
    policy = compile_policy(intent)
    assert policy.actions[0].release.final_answer == "prohibited"


def test_compatible_same_turn_restrictions_on_different_fields_both_survive():
    """"Show the method but don't show the result." — two trusted actions,
    same turn, but they touch DIFFERENT fields, so there is no real
    conflict at all; both must independently survive."""
    intent = _intent([
        Action(objective="explain", target="5", state="requested",
               release=ReleaseConstraints(explanation_depth="worked_derivation")),
        Action(objective="solve", target="5", state="prohibited",
               release=ReleaseConstraints(final_answer="prohibited")),
    ])
    policy = compile_policy(intent)
    release = policy.actions[0].release
    assert release.explanation_depth == "worked_derivation"
    assert release.final_answer == "prohibited"


def test_earlier_turn_prohibition_then_verified_later_turn_permission():
    ledger = _ledger({"turn-1": {}, "turn-2": {}})
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited", changed_by_turn="turn-1")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-2")),
    ], conversation="correction")
    policy = compile_policy(intent, turn_ledger=ledger)
    assert policy.actions[0].release.final_answer == "permitted"


def test_historical_actions_out_of_chronological_order_use_ledger_not_list_position():
    """The chronologically LATER action (turn-2) is listed FIRST; the
    chronologically EARLIER action (turn-1) is listed SECOND. A compiler
    that trusted raw list position would let the earlier one win just
    because it came last in the list. The ledger must override that."""
    ledger = _ledger({"turn-1": {}, "turn-2": {}})
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-2")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited", changed_by_turn="turn-1")),
    ])
    policy = compile_policy(intent, turn_ledger=ledger)
    # turn-2 is chronologically later than turn-1, regardless of list order.
    assert policy.actions[0].release.final_answer == "permitted"


def test_forged_changed_by_turn_cannot_override_a_verified_trusted_value():
    ledger = _ledger({"turn-1": {}})
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-99-forged")),
    ])
    policy = compile_policy(intent, turn_ledger=ledger)
    # The forged marker can't prove it's later, so the tie-break applies —
    # prohibited (more restrictive) wins over the forged override attempt.
    assert policy.actions[0].release.final_answer == "prohibited"
    assert any(e.startswith("forged_turn_marker:5:final_answer") for e in policy.platform_policy_applied)
    assert policy.needs_clarification is True


def test_mismatched_changed_by_turn_without_any_ledger_preserves_the_known_constraint():
    """Decision 2 hardening (this REPLACES the old, incorrect expectation
    that a no-ledger call falls back to list order): when NO ledger is
    supplied at all, an unverifiable label claiming to be "later" must
    NOT override — the compiler preserves the already-established,
    trusted value instead of granting the labeled action's permission,
    and flags the target for clarification. List position is never
    consulted for this decision, regardless of which action is listed
    first."""
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-claims-to-be-later")),
    ])
    policy = compile_policy(intent)  # no turn_ledger supplied
    assert policy.actions[0].release.final_answer == "prohibited"  # preserved, not granted
    assert policy.needs_clarification is True
    assert any(e.startswith("missing_required_history:5:final_answer") for e in policy.platform_policy_applied)


def test_missing_required_history_case_is_order_independent():
    """Same scenario with the labeled action listed FIRST instead of
    second — must behave identically (never position-dependent)."""
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-claims-to-be-later")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
    ])
    policy = compile_policy(intent)
    assert policy.actions[0].release.final_answer == "prohibited"
    assert policy.needs_clarification is True


# ===========================================================================
# Decision 2: explicit history-free mode, empty-vs-None ledger, and
# cross-conversation turn forgery, exercised at the compile_policy level.
# ===========================================================================

def test_history_mode_none_forces_history_free_even_if_a_ledger_is_passed():
    """A truly single-turn request can explicitly opt out of history
    entirely — history_mode="none" ignores any turn_ledger passed in,
    rather than silently trusting it."""
    ledger = _ledger({"turn-1": {}, "turn-99-forged": {}})
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-99-forged")),
    ])
    policy = compile_policy(intent, turn_ledger=ledger, history_mode="none")
    # Even though "turn-99-forged" really is in the supplied ledger,
    # history_mode="none" means it is never consulted at all.
    assert policy.actions[0].release.final_answer == "prohibited"
    assert policy.needs_clarification is True


def test_explicitly_empty_ledger_differs_from_no_ledger_in_the_audit_trail():
    """An explicitly empty TurnLedger ("checked, found nothing") and
    turn_ledger=None ("never checked") produce the SAME safe outcome for
    an unresolvable label, but a DIFFERENT audit tag — forged (ledger
    present, not found) vs. missing-required-history (no ledger at all)."""
    action_pair = [
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-99")),
    ]
    policy_no_ledger = compile_policy(_intent(action_pair))
    policy_empty_ledger = compile_policy(_intent(action_pair), turn_ledger=TurnLedger.empty("conv-1"))

    assert policy_no_ledger.actions[0].release.final_answer == "prohibited"
    assert policy_empty_ledger.actions[0].release.final_answer == "prohibited"
    assert any(e.startswith("missing_required_history:5:final_answer") for e in policy_no_ledger.platform_policy_applied)
    assert any(e.startswith("forged_turn_marker:5:final_answer") for e in policy_empty_ledger.platform_policy_applied)
    assert not any(e.startswith("forged_turn_marker:") for e in policy_no_ledger.platform_policy_applied)
    assert not any(e.startswith("missing_required_history:") for e in policy_empty_ledger.platform_policy_applied)


def test_cross_conversation_turn_forgery_is_rejected_even_with_a_real_ledger():
    """A turn_id that is REAL in the supplied ledger still must not
    authorize anything when the ledger's own conversation_id doesn't
    match the request's authenticated conversation_id."""
    ledger = _ledger({"turn-1": {}, "turn-2": {}}, conversation_id="conv-A")
    intent = _intent([
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="prohibited", changed_by_turn="turn-1")),
        Action(objective="solve", target="5", state="requested",
               release=ReleaseConstraints(final_answer="permitted", changed_by_turn="turn-2")),
    ])
    # Correct conversation_id: the ledger verifies normally, turn-2 wins.
    policy_same_conv = compile_policy(intent, turn_ledger=ledger, conversation_id="conv-A")
    assert policy_same_conv.actions[0].release.final_answer == "permitted"

    # Wrong conversation_id: neither turn_id resolves against this ledger
    # at all — both markers degrade to unverifiable, never an override.
    policy_cross_conv = compile_policy(intent, turn_ledger=ledger, conversation_id="conv-B")
    assert policy_cross_conv.actions[0].release.final_answer == "prohibited"
    assert policy_cross_conv.needs_clarification is True


# ===========================================================================
# Hardening pass: exercise target hierarchy (canonical parser, not prefix).
# ===========================================================================

def test_unrelated_numeric_labels_5_and_50_do_not_inherit():
    intent = _intent([
        Action(objective="explain", target="5", state="requested",
               release=ReleaseConstraints(explanation_depth="worked_derivation")),
        Action(objective="solve", target="50", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ])
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["50"].explanation_depth != "worked_derivation"
    assert not any("narrow_target_inherits:50<-5:" in e for e in policy.platform_policy_applied)


def test_5a_and_5ab_are_not_a_recognized_label_relationship():
    intent = _intent([
        Action(objective="explain", target="5a", state="requested",
               release=ReleaseConstraints(explanation_depth="worked_derivation")),
        Action(objective="solve", target="5ab", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ])
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5ab"].explanation_depth != "worked_derivation"
    assert not any("narrow_target_inherits:5ab<-5a:" in e for e in policy.platform_policy_applied)


def test_nested_exercise_label_5a_and_5a1_inherit_correctly():
    intent = _intent([
        Action(objective="explain", target="5a", state="requested",
               release=ReleaseConstraints(explanation_depth="worked_derivation")),
        Action(objective="solve", target="5a1", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ])
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5a1"].explanation_depth == "worked_derivation"
    assert any("narrow_target_inherits:5a1<-5a:" in e for e in policy.platform_policy_applied)


def test_unrelated_quantity_identifiers_f_and_fx_do_not_inherit():
    intent = _intent([
        Action(objective="explain", target="F", state="requested",
               release=ReleaseConstraints(explanation_depth="worked_derivation")),
        Action(objective="solve", target="Fx", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
    ])
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["Fx"].explanation_depth != "worked_derivation"
    assert not any("narrow_target_inherits:Fx<-F:" in e for e in policy.platform_policy_applied)


# ===========================================================================
# Hardening pass: policy hashing includes evidence_requirements.
# ===========================================================================

def test_policy_hash_changes_when_evidence_requirements_differ_but_actions_do_not():
    same_actions = (Action(objective="explain", target="5", state="requested"),)
    hash_without_evidence = compute_policy_hash(
        actions=same_actions, response_language="en", evidence_requirements=(),
        platform_policy_applied=(), policy_version="1.1.0", compiler_version="1.1.0",
    )
    hash_with_evidence = compute_policy_hash(
        actions=same_actions, response_language="en", evidence_requirements=("course_grounding_required",),
        platform_policy_applied=(), policy_version="1.1.0", compiler_version="1.1.0",
    )
    assert hash_without_evidence != hash_with_evidence


# ===========================================================================
# Hint-objective fallback (live-eval fix, 2026-10-20): a "hint" objective
# must never silently compile final_answer/form open via the general
# _TUTORING_DEFAULT just because extraction left those fields
# unspecified -- confirmed live, 20/20 cases in the independent eval
# (reports/semantic-intent-phase-d-eval-2026-10-20.md, eval worktree)
# where layer1 extraction dropped release fields to "unspecified" and
# this default alone then opened final_answer to "permitted" for
# explicit hint-only requests.
# ===========================================================================

def test_hint_objective_with_unspecified_release_defaults_to_prohibited_not_permitted():
    """The exact live-eval failure shape: objective="hint", target
    extracted correctly, but release left completely unspecified
    (exactly what the real gpt-4o-mini response produced under the
    pre-fix prompt, after unwrapping its mis-nested JSON). Must compile
    to final_answer="prohibited", form="hint" -- never the general
    tutoring default ("permitted"/"explanation") an "explain"/"solve"
    objective would correctly get in the same situation."""
    policy = compile_policy(_intent([
        Action(objective="hint", target="7", state="requested", release=ReleaseConstraints()),
    ]))
    action = policy.actions[0]
    assert action.release.final_answer == "prohibited"
    assert action.release.form == "hint"


def test_non_hint_objective_with_unspecified_release_is_unaffected():
    """Non-regression: an "explain"/"solve" objective with unspecified
    release must still get the ordinary tutoring default (final_answer
    defaults open) -- the hint-objective fallback is scoped exactly to
    objective="hint", not a general tightening of the fallback rule."""
    policy = compile_policy(_intent([
        Action(objective="solve", target="9", state="requested", release=ReleaseConstraints()),
    ]))
    action = policy.actions[0]
    assert action.release.final_answer == "permitted"
    assert action.release.form == "explanation"


def test_hint_objective_explicit_final_answer_from_any_turn_still_wins():
    """Non-regression: if ANY trusted action for this target (this turn
    or an earlier one) explicitly addressed final_answer, that explicit
    value wins exactly as before -- the hint-objective fallback only
    ever fires when the field was never addressed at all, not when the
    student explicitly permitted the final answer alongside a hint-
    shaped request."""
    policy = compile_policy(_intent([
        Action(
            objective="hint", target="7", state="requested",
            release=ReleaseConstraints(final_answer="permitted"),
        ),
    ]))
    action = policy.actions[0]
    assert action.release.final_answer == "permitted"


def test_hint_objective_widened_to_solve_by_a_later_turn_no_longer_gets_the_hint_default():
    """A later turn's explicit widening to a different objective (e.g.
    "actually just solve it fully") becomes this target's new primary
    objective (the last requested action for the target -- same rule
    every other "which objective governs this target" case already
    follows) -- the hint-only fallback must not keep applying once the
    CURRENT, authoritative objective for this target is no longer
    "hint"."""
    policy = compile_policy(_intent([
        Action(objective="hint", target="7", state="requested"),
        Action(objective="solve", target="7", state="requested"),
    ]))
    action = policy.actions[0]
    assert action.objective == "solve"
    assert action.release.final_answer == "permitted"

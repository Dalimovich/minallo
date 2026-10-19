"""Tests for the one-way ExecutionPolicy -> legacy PR3 AnswerConstraints
projection (app/services/legacy_constraint_projection.py).

Pure, no network. Builds real ExecutionPolicy objects via compile_policy
(already tested elsewhere) rather than hand-constructing one, so these
tests exercise the real boundary this module reads from.
"""

from app.services.legacy_constraint_projection import project_execution_policy_to_legacy_constraints
from app.services.policy_compiler import compile_policy
from app.services.resolved_student_intent import SCHEMA_VERSION, Action, ReleaseConstraints, ResolvedStudentIntent


def _intent(actions, **kw):
    kw.setdefault("conversation", "new")
    kw.setdefault("message", "x")
    kw.setdefault("response_language", "en")
    return ResolvedStudentIntent(
        schema_version=SCHEMA_VERSION, original_message=kw["message"], student_goal=kw["message"],
        actions=tuple(actions), conversation=kw["conversation"], references=None,
        response_language=kw["response_language"], teaching=None, trust=None,
    )


def test_single_target_withhold_answer_projects_true():
    policy = compile_policy(_intent([
        Action(objective="official_solution", target="task", state="prohibited",
               release=ReleaseConstraints(final_answer="prohibited")),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.withhold_answer is True
    assert projection.hint_only is False
    assert projection.one_question_at_a_time is False


def test_single_target_hint_only_projects_true():
    policy = compile_policy(_intent([
        Action(objective="hint", target="task", state="requested",
               release=ReleaseConstraints(form="hint", final_answer="prohibited")),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.hint_only is True
    assert projection.withhold_answer is True  # hint form implies the final answer is also withheld


def test_single_target_wait_for_student_projects_one_question_at_a_time():
    policy = compile_policy(_intent([
        Action(objective="solve", target="task", state="requested",
               release=ReleaseConstraints(wait_for_student=True)),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.one_question_at_a_time is True


def test_no_active_constraints_projects_all_false():
    policy = compile_policy(_intent([
        Action(objective="explain", target="task", state="requested"),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.withhold_answer is False
    assert projection.hint_only is False
    assert projection.one_question_at_a_time is False


def test_multi_target_policy_returns_none_stays_gated():
    """Case C shape: two targets, opposite constraints. This is exactly
    the information a single global boolean cannot safely represent —
    the function refuses rather than guessing which target's value a
    legacy single-shot consumer's one answer would even apply to."""
    policy = compile_policy(_intent([
        Action(objective="official_solution", target="5", state="prohibited",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="official_solution", target="6", state="requested",
               release=ReleaseConstraints(official_solution="permitted")),
    ]))
    assert project_execution_policy_to_legacy_constraints(policy) is None


def test_needs_clarification_policy_returns_none_stays_gated():
    policy = compile_policy(_intent([
        Action(objective="other", target="unknown", state="unresolved"),
    ]))
    assert policy.needs_clarification is True
    assert project_execution_policy_to_legacy_constraints(policy) is None


def test_projection_never_widens_relative_to_a_restrictive_single_target():
    """Sanity: for every field, the projection is a function of the
    COMPILED (already-fully-resolved, never "unspecified") release — it
    can only reflect what's already there, never loosen it further."""
    policy = compile_policy(_intent([
        Action(objective="review_student_solution", target="task", state="unresolved"),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    # A fully-unresolved single action still has needs_clarification=True,
    # so this stays gated too — never projects a (possibly wrong) answer.
    assert projection is None


# ===========================================================================
# M3 PR-1 addendum: shapes PR3's three global booleans structurally cannot
# express, named explicitly rather than silently handled. For each,
# project_execution_policy_to_legacy_constraints(...) is None — "the
# canonical policy cannot be represented by the legacy interface" — which
# is NOT the same claim as "falling back to the legacy detector is safe".
# A caller that treats None as "safe to fall back" without separately
# checking WHY would be wrong; these tests pin that distinction down.
# ===========================================================================

def test_multi_target_mixed_permissions_cannot_be_represented_legacy_stays_gated():
    """Case H shape: one target fully permitted, a different target
    hint-only. No single (withhold_answer, hint_only, one_question_at_a_
    time) triple can represent "permitted for 5a, hint-only for 5b"."""
    policy = compile_policy(_intent([
        Action(objective="solve", target="5a", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
        Action(objective="hint", target="5b", state="requested",
               release=ReleaseConstraints(form="hint", final_answer="prohibited")),
    ]))
    assert project_execution_policy_to_legacy_constraints(policy) is None


def test_hint_form_with_final_answer_permitted_is_a_real_combination_pr3_has_no_field_for():
    """PR3's hint_only implies (via this packet's own mapping) "the
    answer is also withheld" in practice — but the CANONICAL schema can
    independently express form="hint" delivery WITH final_answer=
    "permitted" (e.g. "give me a hint-shaped walkthrough, but you can
    tell me the final number"). Single target, so the projection DOES
    fire — demonstrating that hint_only=True in the projection can lose
    the fact that final_answer was actually permitted, since PR3 has no
    separate field for delivery-form vs. final-answer disclosure."""
    policy = compile_policy(_intent([
        Action(objective="hint", target="task", state="requested",
               release=ReleaseConstraints(form="hint", final_answer="permitted")),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.hint_only is True
    assert projection.withhold_answer is False  # correctly preserved in THIS single-target case
    # The point: PR3's AnswerConstraints has no field at all that could
    # carry "hint-shaped delivery, answer still permitted" as a single
    # concept distinct from hint_only itself — a future PR3-side consumer
    # reading ONLY hint_only (as today's prompt-overlay text does: "Give
    # a hint only. Do NOT provide ... the final result.") would still
    # contradict final_answer=permitted. This is a real, structural
    # mismatch between the two systems' field granularity, not a bug in
    # this projection.


def test_prohibited_official_solution_but_otherwise_permitted_tutor_answer():
    """A real, legitimate combination: the instructor's official solution
    key stays prohibited, but the tutor's OWN computed final answer is
    permitted. PR3 has exactly one boolean (withhold_answer) covering
    both concepts conflated into one — this combination cannot round-
    trip through the legacy projection without losing the distinction."""
    policy = compile_policy(_intent([
        Action(objective="official_solution", target="task", state="requested",
               release=ReleaseConstraints(official_solution="prohibited", final_answer="permitted")),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.withhold_answer is False  # only reflects final_answer — official_solution has no PR3 equivalent at all


def test_wait_for_student_vs_max_items_are_distinct_dimensions_pr3_collapses():
    """one_question_at_a_time maps to wait_for_student in this packet's
    chosen mapping (§3 of the reconciliation doc) — but max_items is a
    SEPARATE dimension (how many items total, independent of whether the
    tutor pauses between them). PR3 has no field for max_items at all;
    this projection only ever reflects wait_for_student, silently
    dropping max_items information a migrated consumer would need."""
    policy = compile_policy(_intent([
        Action(objective="solve", target="task", state="requested",
               release=ReleaseConstraints(wait_for_student=True, max_items=1)),
    ]))
    projection = project_execution_policy_to_legacy_constraints(policy)
    assert projection is not None
    assert projection.one_question_at_a_time is True
    # No field on LegacyAnswerConstraintsProjection carries max_items at
    # all — confirmed structurally, not just by this assertion's absence:
    import dataclasses
    assert {f.name for f in dataclasses.fields(projection)} == {
        "withhold_answer", "hint_only", "one_question_at_a_time",
    }


def test_none_projection_is_not_proof_fallback_is_safe_it_is_a_refusal():
    """Explicit regression for a real misreading risk: None must be read
    as "the canonical policy cannot be represented by the legacy
    interface", never as "it is therefore safe to use the legacy
    detector's own guess instead". This test exists to pin the contract
    down in code, not just in the docstring."""
    policy = compile_policy(_intent([
        Action(objective="official_solution", target="5", state="prohibited",
               release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="official_solution", target="6", state="requested",
               release=ReleaseConstraints(official_solution="permitted")),
    ]))
    assert project_execution_policy_to_legacy_constraints(policy) is None
    # The canonical policy for target "5" is unambiguously prohibited —
    # a caller that saw None and fell back to "no constraints active"
    # (PR3's own all-False default) would be WRONG, not merely
    # imprecise. This is why §4/§9 of the reconciliation/M3 docs require
    # the gated path to stay gated (e.g. ask for clarification, or keep
    # serving via the UNMIGRATED legacy detector's OWN independent
    # detection — never silently treat None as "nothing is restricted").
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5"].final_answer == "prohibited"

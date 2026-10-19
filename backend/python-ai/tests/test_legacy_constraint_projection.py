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

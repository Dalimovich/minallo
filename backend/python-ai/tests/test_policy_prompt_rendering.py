"""Tests for the per-target ExecutionPolicy -> prompt-overlay renderer
(Milestone 4 Phase C)."""

from app.services.policy_compiler import ExecutionPolicy
from app.services.policy_prompt_rendering import render_execution_policy_overlay
from app.services.resolved_student_intent import Action, ReleaseConstraints


def _policy(actions, needs_clarification=False, clarification_question=None) -> ExecutionPolicy:
    return ExecutionPolicy(
        actions=tuple(actions), evidence_requirements=(), needs_clarification=needs_clarification,
        clarification_question=clarification_question, response_language="en",
        response_language_reason="default", platform_policy_applied=(),
        policy_version="1.0.0", compiler_version="1.0.0", policy_hash="deadbeef",
    )


def test_none_policy_renders_nothing():
    assert render_execution_policy_overlay(None) == ""


def test_fully_unspecified_policy_renders_nothing():
    policy = _policy([Action(objective="solve", target="5a")])
    assert render_execution_policy_overlay(policy) == ""


def test_case_h_opposite_permissions_for_two_targets_render_independently():
    """The core Milestone 2 deliverable: 5a permitted, 5b hint-only, in
    ONE rendered overlay — neither leaks into the other."""
    policy = _policy([
        Action(objective="solve", target="5a", release=ReleaseConstraints(final_answer="permitted")),
        Action(objective="hint", target="5b", release=ReleaseConstraints(final_answer="prohibited", form="hint")),
    ])
    overlay = render_execution_policy_overlay(policy)
    assert '"5a"' in overlay and '"5b"' in overlay
    lines = overlay.splitlines()
    line_5a = next(l for l in lines if '"5a"' in l)
    line_5b = next(l for l in lines if '"5b"' in l)
    assert "MAY be shown" in line_5a
    assert "do NOT reveal the final" in line_5b
    assert "HINT only" in line_5b
    # 5a's permission text must not appear on 5b's line and vice versa.
    assert "MAY be shown" not in line_5b
    assert "HINT only" not in line_5a


def test_case_c_opposite_solution_permissions():
    """'Keine Lösung für Aufgabe 5. Aber für Aufgabe 6 will ich die
    vollständige Musterlösung.'"""
    policy = _policy([
        Action(objective="solve", target="5", release=ReleaseConstraints(final_answer="prohibited")),
        Action(objective="official_solution", target="6", release=ReleaseConstraints(official_solution="permitted")),
    ])
    overlay = render_execution_policy_overlay(policy)
    line_5 = next(l for l in overlay.splitlines() if '"5"' in l and '"5a"' not in l)
    line_6 = next(l for l in overlay.splitlines() if '"6"' in l)
    assert "do NOT reveal the final" in line_5
    assert "official/instructor solution key MAY" in line_6 or "official solution MAY be shown" in line_6


def test_prohibited_objectives_rendered():
    policy = _policy([Action(objective="explain", target="F", prohibited=("solve",))])
    overlay = render_execution_policy_overlay(policy)
    assert "never perform: solve" in overlay


def test_explanation_depth_none_rendered_for_review_case():
    """Milestone 1 case K: 'Don't explain the method, just tell me if my
    result 42 N is right.'"""
    policy = _policy([Action(
        objective="review_student_solution", target="unresolved",
        release=ReleaseConstraints(explanation_depth="none", form="worked_solution"),
    )])
    overlay = render_execution_policy_overlay(policy)
    assert "do not explain the method" in overlay
    assert "this request" in overlay  # unresolved target uses the generic label


def test_clarification_question_rendered_when_needed():
    policy = _policy(
        [Action(objective="other", target="unresolved", state="unresolved")],
        needs_clarification=True, clarification_question="Which exercise do you mean?",
    )
    overlay = render_execution_policy_overlay(policy)
    assert "Which exercise do you mean?" in overlay


def test_max_steps_and_max_items_rendered():
    policy = _policy([Action(
        objective="solve", target="5a",
        release=ReleaseConstraints(max_steps=1, max_items=2),
    )])
    overlay = render_execution_policy_overlay(policy)
    assert "at most 1 step" in overlay
    assert "at most 2 item" in overlay


def test_wait_for_student_rendered():
    policy = _policy([Action(
        objective="solve", target="5a", release=ReleaseConstraints(wait_for_student=True),
    )])
    overlay = render_execution_policy_overlay(policy)
    assert "wait for the student" in overlay

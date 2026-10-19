"""Semantic Student Intent Layer Phase C — renders a compiled
``ExecutionPolicy`` into prompt-overlay text, PER TARGET.

This is the piece PR3's legacy ``AnswerConstraints``/``legacy_constraint_
projection.py`` structurally cannot do: a single global ``withhold_
answer`` boolean has no way to say "5a may show the answer, 5b must stay
hint-only" — collapsing two opposite per-target constraints into one
boolean would silently apply the WRONG one to whichever answer is
actually generated (see docs/semantic-intent-milestone-1-report.md's
case C/H). This module renders ONE instruction block per
``Action``/target instead, so each target's constraints stay legible and
independent in the prompt the model actually sees.

This is prompt-overlay text only — the same enforcement LEVEL PR3's own
reconciliation packet already names as a real limitation ("enforcement
mechanism is prompt-overlay only, with no structural/verification check
of compliance"). The independent, deterministic backstop that actually
verifies the model obeyed this text lives in
``answer_release_validator.py`` (Phase D) — this module's job ends at
producing the instruction text.
"""

from __future__ import annotations

from .policy_compiler import ExecutionPolicy, is_mixed_permission_policy
from .resolved_student_intent import Action, ReleaseConstraints

_HEADER = "\nSTUDENT-REQUESTED ANSWER CONSTRAINTS (explicit — do not weaken, ignore, or override these):"

_SECTIONING_HEADER = (
    "\nThis reply must give DIFFERENT, independently-governed treatment to "
    "different parts of this exercise. Structure your ENTIRE reply using "
    "EXACTLY this format — no text before the first marker, no text after "
    "the final [[END]] marker, exactly one section per target listed below, "
    "nothing more, nothing less:"
)


def _is_fully_unspecified(release: ReleaseConstraints) -> bool:
    return (
        release.final_answer == "unspecified"
        and release.official_solution == "unspecified"
        and release.explanation_depth == "unspecified"
        and release.form == "unspecified"
        and release.max_steps is None
        and release.max_items is None
        and release.wait_for_student is None
    )


def _target_label(action: Action) -> str:
    if action.target in {"unresolved", "current_request", ""}:
        return "this request"
    return f'"{action.target}"'


def _render_action_instruction(action: Action) -> str | None:
    """One line of instruction text for a single action/target, or None
    if this action carries no actual release restriction worth stating
    (an all-``unspecified`` release and no prohibited list)."""
    release = action.release
    if _is_fully_unspecified(release) and not action.prohibited:
        return None

    parts: list[str] = []
    if release.final_answer == "prohibited":
        parts.append("do NOT reveal the final numeric/symbolic result")
    elif release.final_answer == "permitted":
        parts.append("the final result MAY be shown")
    if release.official_solution == "prohibited":
        parts.append("do NOT reveal the official/instructor solution key")
    elif release.official_solution == "permitted":
        parts.append("the official solution MAY be shown")
    if release.form == "hint":
        parts.append("respond with a HINT only, not a worked solution")
    elif release.form == "guided_questions":
        parts.append("respond with guiding questions, not a direct answer")
    elif release.form == "worked_solution":
        parts.append("provide a full worked solution")
    if release.explanation_depth == "none":
        parts.append("do not explain the method — state only whether it is correct")
    elif release.explanation_depth == "method":
        parts.append("explain only the METHOD, not every computational step")
    elif release.explanation_depth == "worked_derivation":
        parts.append("give the full worked derivation")
    if release.max_steps is not None:
        parts.append(f"show at most {release.max_steps} step(s)")
    if release.max_items is not None:
        parts.append(f"cover at most {release.max_items} item(s)")
    if release.wait_for_student is True:
        parts.append("stop here and wait for the student's own attempt before continuing")
    if action.prohibited:
        parts.append(f"never perform: {', '.join(action.prohibited)}")

    if not parts:
        return None
    return f"- For {_target_label(action)} ({action.objective}): " + "; ".join(parts) + "."


def render_execution_policy_overlay(policy: ExecutionPolicy | None) -> str:
    """The system-prompt text for a compiled policy, one instruction line
    per target. Returns "" (no-op, safe to always ``+=``) when ``policy``
    is ``None`` or carries no actual restriction — the same "additive,
    zero behavior change when absent" contract every other overlay in
    ``answer.py``/``answer_stream.py`` already follows (``request_plan_
    overlay``, ``_diagram_overlay``, ``exam_style_overlay``). When the
    compiled policy genuinely needs per-target treatment (Priority 2 —
    see ``policy_compiler.is_mixed_permission_policy``), this also
    appends ``render_target_sectioning_contract``'s structural
    instruction, so a caller gets both without a second call."""
    if policy is None:
        return ""
    lines = [_render_action_instruction(action) for action in policy.actions]
    lines = [line for line in lines if line is not None]
    if not lines and not (policy.needs_clarification and policy.clarification_question):
        return render_target_sectioning_contract(policy)
    out = [_HEADER, *lines]
    if policy.needs_clarification and policy.clarification_question:
        out.append(
            "- If genuinely ambiguous which target(s) this applies to, ask exactly this "
            f"clarifying question instead of guessing: {policy.clarification_question}"
        )
    return "\n".join(out) + "\n" + render_target_sectioning_contract(policy)


def render_target_sectioning_contract(policy: ExecutionPolicy | None) -> str:
    """Instructs the model to emit one verifiably-delimited section per
    target when (and only when) the compiled policy genuinely needs
    per-target treatment — e.g. "show 5a's full answer, hint-only for
    5b". The literal ``[[TARGET: ...]]``/``[[END]]`` markers this
    renders are parsed and verified SERVER-SIDE by ``answer_release_
    validator.parse_target_sections`` — a model-written prose heading
    ("**5a:**") is never trusted for attribution on its own, only these
    markers are. Returns "" (no-op) whenever a per-target split isn't
    needed, exactly like every other conditional overlay in this
    module."""
    if not is_mixed_permission_policy(policy):
        return ""
    assert policy is not None  # is_mixed_permission_policy already guards this
    lines: list[str] = [_SECTIONING_HEADER]
    for action in policy.actions:
        lines.append(f"[[TARGET: {action.target}]]")
        lines.append(f"<your {action.objective} content for {_target_label(action)} here>")
    lines.append("[[END]]")
    return "\n".join(lines) + "\n"


__all__ = ["render_execution_policy_overlay", "render_target_sectioning_contract"]

"""One-way compatibility projection: canonical ``ExecutionPolicy`` ->
PR3's legacy global ``AnswerConstraints`` shape (``withhold_answer``/
``hint_only``/``one_question_at_a_time`` — branch
``feature/semantic-intent-constraints``, ``student_intent.py``).

Direction matters and is enforced by this module's own shape: there is no
function here that goes the other way. Deriving the canonical per-action
``ExecutionPolicy`` FROM three global booleans would throw away exactly
the target-specific information Milestone 2 exists to represent (case C:
"no solution for 5, full solution for 6" — two opposite answers, one
turn — collapses to a single ambiguous boolean and back is lossy in the
wrong direction). This module only ever projects the richer object down
to the narrower one, for consumers that have not migrated yet.

NOT wired into any PR3 consumer file — this is additive, read-only with
respect to PR3's own branch/files, built from this side of the
compatibility boundary. See docs/semantic-intent-pr3-reconciliation.md
for the full consumer-by-consumer migration plan this supports.
"""

from __future__ import annotations

from dataclasses import dataclass

from .policy_compiler import ExecutionPolicy


@dataclass(frozen=True)
class LegacyAnswerConstraintsProjection:
    """Structurally mirrors PR3's ``AnswerConstraints`` field-for-field
    (same three names), so its owner can adopt this 1:1 without renaming
    anything. Deliberately NOT the same type — this branch does not (and
    must not) import from PR3's unmerged branch. A pure value object."""

    withhold_answer: bool
    hint_only: bool
    one_question_at_a_time: bool


def project_execution_policy_to_legacy_constraints(
    policy: ExecutionPolicy,
) -> LegacyAnswerConstraintsProjection | None:
    """Project one ``ExecutionPolicy`` down to PR3's global shape, for an
    UNMIGRATED consumer that only understands one turn-wide answer, not
    per-target actions.

    Returns ``None`` — "do not use this projection; fall back to PR3's
    own existing deterministic detector for this turn, unchanged" —
    whenever collapsing to one global answer would be unsafe or
    meaningless:

    - ``policy.needs_clarification`` is True: nothing here is safe to
      answer confidently yet; a legacy consumer has no clarification
      concept to hand this to.
    - More than one target (``len(policy.actions) != 1``): a multi-target
      policy (case C: "no solution for 5, full solution for 6"; case H:
      full answer for 5a, hint only for 5b) genuinely cannot be
      represented as one global boolean without either silently
      withholding something the student WAS allowed to see, or granting
      something for a target they were not — collapsing to
      "most-restrictive-wins" avoids ever WIDENING permissions, but a
      legacy single-shot consumer generating ONE answer for the whole
      turn has no way to know WHICH target that most-restrictive value
      even came from. Per the explicit instruction this module was built
      against: that path stays gated (returns ``None``) until the
      consumer migrates to reading ``ExecutionPolicy.actions`` directly,
      rather than building an adapter that could silently apply the
      wrong target's constraint to the wrong answer.

    The single-target case is the only one this function will ever
    project, and the projection can only ever TIGHTEN relative to what a
    legacy consumer would otherwise do on its own (PR3's deterministic
    detector), never loosen — see the field mapping table in
    docs/semantic-intent-pr3-reconciliation.md for the exact
    correspondence and the reasoning behind each choice.
    """
    if policy.needs_clarification:
        return None
    if len(policy.actions) != 1:
        return None
    release = policy.actions[0].release
    return LegacyAnswerConstraintsProjection(
        withhold_answer=(release.final_answer == "prohibited"),
        hint_only=(release.form == "hint"),
        one_question_at_a_time=bool(release.wait_for_student),
    )


__all__ = ["LegacyAnswerConstraintsProjection", "project_execution_policy_to_legacy_constraints"]

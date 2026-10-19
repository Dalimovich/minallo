"""Milestone 2 ("isolated foundations") — the multi-action student-intent
contract.

Today's ``StudentIntent`` (``app/services/student_intent.py``) has one
global ``primary_task`` and one global ``prohibited_tasks`` tuple for the
whole turn. That makes "don't show the solution for exercise 5, but give me
the full solution for exercise 6" unrepresentable: one task, one prohibition
list, no notion of *which exercise* a constraint applies to.

``ResolvedStudentIntent`` is the replacement contract: one or more
``Action`` entries, each scoped to its own ``target`` and carrying its own
``ReleaseConstraints`` (how much may be revealed, in what form, under what
conditions). It is purely additive — this module does not modify
``StudentIntent`` or anything that reads it. ``derive_primary_task`` /
``derive_prohibited_tasks`` below are the bridge a Milestone 3 adapter would
use so that any consumer still reading the old scalar fields keeps working
unchanged, per the Milestone 1 design decision.

Nothing in this module is wired into ``/ask``, ``/ask-stream``, generation,
grounding, caching, or persistence. It is not imported by any router.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

from .answer_intent import AcademicIntent

SCHEMA_VERSION = "1.0.0"

OriginKind = Literal["current_message", "conversation_turn", "viewer_metadata", "unresolved"]
ReleaseState = Literal["permitted", "prohibited", "unspecified"]
ExplanationDepth = Literal["none", "concept", "method", "worked_derivation", "unspecified"]
ReleaseForm = Literal["hint", "guided_questions", "explanation", "worked_solution", "unspecified"]
Objective = Literal[
    "explain", "define", "solve", "derive", "review_student_solution",
    "official_solution", "exam_practice", "hint", "compare",
    "summarize", "answer_subquestion", "translate", "other",
]
ActionState = Literal["requested", "prohibited", "unspecified", "unresolved"]
ConversationShape = Literal[
    "new", "follow_up", "correction", "rejection", "exercise_switch", "permission_update",
]


@dataclass(frozen=True)
class Origin:
    """Where one action/field's value came from — the provenance a
    consistency check or an authorization boundary (Milestone 3) can
    inspect. Exactly one of ``span`` / ``turn_id`` / ``context_ref`` is
    meaningful, matching ``kind`` (see ``validate_origin`` for the actual
    trust check — this dataclass itself does not validate)."""

    kind: OriginKind
    span: tuple[int, int] | None = None
    turn_id: str | None = None
    context_ref: str | None = None


@dataclass(frozen=True)
class ReleaseConstraints:
    final_answer: ReleaseState = "unspecified"
    official_solution: ReleaseState = "unspecified"
    explanation_depth: ExplanationDepth = "unspecified"
    form: ReleaseForm = "unspecified"
    max_steps: int | None = None
    max_items: int | None = None
    wait_for_student: bool | None = None
    changed_by_turn: str | None = None


@dataclass(frozen=True)
class Action:
    objective: Objective
    target: str
    release: ReleaseConstraints = ReleaseConstraints()
    prohibited: tuple[str, ...] = ()
    state: ActionState = "unspecified"
    provenance: tuple[Origin, ...] = ()


@dataclass(frozen=True)
class ResolvedStudentIntent:
    schema_version: str
    original_message: str
    student_goal: str
    actions: tuple[Action, ...]
    conversation: ConversationShape
    references: Any
    response_language: str
    teaching: Any
    trust: Any


# ---------------------------------------------------------------------------
# Provenance validation (interpreter/compiler boundary).
# ---------------------------------------------------------------------------

def validate_origin(
    origin: Origin,
    *,
    original_message: str,
    turn_ledger: Mapping[str, Any] | None = None,
    viewer_context: Mapping[str, Any] | None = None,
) -> bool:
    """Is this one ``Origin`` trustworthy on its own?

    - ``current_message``: the span must be a real, in-bounds, non-empty
      slice of ``original_message``.
    - ``conversation_turn``: ``turn_id`` must resolve against the caller's
      own trusted turn ledger (a ``Mapping[str, Any]`` the caller passes in
      — Milestone 3 wires this to real persistence; a forged/unknown
      ``turn_id`` never resolves here, by construction).
    - ``viewer_metadata``: ``context_ref`` must resolve against the trusted
      viewer-context mapping, same idea.
    - ``unresolved``: never valid — it is the explicit "we don't know"
      marker, not a claim to verify.
    """
    if origin.kind == "current_message":
        span = origin.span
        if span is None:
            return False
        start, end = span
        return 0 <= start < end <= len(original_message)
    if origin.kind == "conversation_turn":
        if not origin.turn_id or turn_ledger is None:
            return False
        return origin.turn_id in turn_ledger
    if origin.kind == "viewer_metadata":
        if not origin.context_ref or viewer_context is None:
            return False
        return origin.context_ref in viewer_context
    return False  # "unresolved" (or any future kind) is never self-valid.


def validate_action_provenance(
    action: Action,
    *,
    original_message: str,
    turn_ledger: Mapping[str, Any] | None = None,
    viewer_context: Mapping[str, Any] | None = None,
) -> Action:
    """An action whose only provenance fails validation downgrades to
    ``state="unresolved"`` for that action — never a guess. An action with
    no provenance at all is left alone (provenance is optional; plenty of
    deterministic parses have none and are still trustworthy, e.g. an
    unambiguous explicit instruction the interpreter resolved directly)."""
    if not action.provenance:
        return action
    if any(
        validate_origin(
            origin, original_message=original_message,
            turn_ledger=turn_ledger, viewer_context=viewer_context,
        )
        for origin in action.provenance
    ):
        return action
    if action.state == "unresolved":
        return action
    from dataclasses import replace
    return replace(action, state="unresolved")


def validate_intent_provenance(
    intent: ResolvedStudentIntent,
    *,
    turn_ledger: Mapping[str, Any] | None = None,
    viewer_context: Mapping[str, Any] | None = None,
) -> ResolvedStudentIntent:
    """Apply ``validate_action_provenance`` to every action in one intent."""
    from dataclasses import replace
    validated = tuple(
        validate_action_provenance(
            action, original_message=intent.original_message,
            turn_ledger=turn_ledger, viewer_context=viewer_context,
        )
        for action in intent.actions
    )
    return replace(intent, actions=validated)


# ---------------------------------------------------------------------------
# Derivation — the Milestone 1 "migrate for one cycle" bridge. Nothing here
# reads from or writes to the real ``StudentIntent`` dataclass; it only
# produces values SHAPED like its old scalar fields, for a future adapter.
# ---------------------------------------------------------------------------

_OBJECTIVE_TO_ACADEMIC_INTENT: dict[Objective, AcademicIntent] = {
    "explain": AcademicIntent.CONCEPTUAL_EXPLANATION,
    "define": AcademicIntent.DEFINITION_OR_THEOREM,
    "solve": AcademicIntent.MATH_PROBLEM,
    "derive": AcademicIntent.MATH_PROBLEM,
    "review_student_solution": AcademicIntent.ANSWER_CORRECTION_OR_GRADING,
    "official_solution": AcademicIntent.MATH_PROBLEM,
    "exam_practice": AcademicIntent.EXAM_GENERATION,
    "hint": AcademicIntent.MATH_PROBLEM,
    "compare": AcademicIntent.COMPARISON,
    "summarize": AcademicIntent.COURSE_SUMMARY,
    "answer_subquestion": AcademicIntent.GENERAL_COURSE_QA,
    "translate": AcademicIntent.TRANSLATION,
    "other": AcademicIntent.GENERAL_COURSE_QA,
}


def derive_primary_task(actions: tuple[Action, ...]) -> AcademicIntent:
    """Best-effort ``actions[0].objective -> primary_task`` mapping — the
    bridge named in the Milestone 1 design so a consumer still reading
    ``StudentIntent.primary_task`` (unchanged, elsewhere) keeps working once
    a Milestone 3 adapter starts producing both shapes from one
    interpretation."""
    if not actions:
        return AcademicIntent.GENERAL_COURSE_QA
    return _OBJECTIVE_TO_ACADEMIC_INTENT.get(actions[0].objective, AcademicIntent.GENERAL_COURSE_QA)


def derive_prohibited_tasks(actions: tuple[Action, ...]) -> tuple[AcademicIntent, ...]:
    """Best-effort ``prohibited_tasks`` mapping: any action whose own
    ``state == "prohibited"`` contributes its mapped ``AcademicIntent``,
    de-duplicated, order preserved."""
    out: list[AcademicIntent] = []
    for action in actions:
        if action.state != "prohibited":
            continue
        mapped = _OBJECTIVE_TO_ACADEMIC_INTENT.get(action.objective)
        if mapped is not None and mapped not in out:
            out.append(mapped)
    return tuple(out)


__all__ = [
    "SCHEMA_VERSION", "Action", "ActionState", "ConversationShape",
    "ExplanationDepth", "Objective", "Origin", "OriginKind", "ReleaseConstraints",
    "ReleaseForm", "ReleaseState", "ResolvedStudentIntent",
    "derive_primary_task", "derive_prohibited_tasks",
    "validate_action_provenance", "validate_intent_provenance", "validate_origin",
]

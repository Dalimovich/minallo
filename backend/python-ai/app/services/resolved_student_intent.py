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

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Sequence

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
# Trusted turn ledger (Decision 2 hardening). A ``TurnLedger`` is NEVER
# accepted blindly from model output or arbitrary client-supplied turn
# metadata — ``TurnLedger.build`` is the one trusted constructor, meant to
# be called by the application boundary from ITS OWN persistence (e.g. a
# DB query already scoped to the authenticated conversation), never from
# a request body or a model response. A raw ``dict``/``Mapping`` is no
# longer accepted anywhere turn history matters (see ``validate_origin``
# below) — that was exactly the "blindly accepted" shape this closes.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class VerifiedTurn:
    turn_id: str
    sequence: int  # the trusted chronological ordering key — never the
    # position this turn happens to occupy in whatever list a caller
    # handed in; TurnLedger.build sorts by this, not by input order.
    data: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TurnLedger:
    """A trusted, chronologically-ordered set of a SINGLE conversation's
    turns. ``conversation_id`` is stamped at construction from the
    authenticated request context and is what ``resolve``/``rank_of``
    check an actual request's own ``conversation_id`` against — a turn_id
    that is real in a DIFFERENT conversation's ledger must never resolve
    just because the string happens to match (cross-conversation turn
    forgery)."""

    conversation_id: str
    turns: tuple[VerifiedTurn, ...] = ()

    @classmethod
    def build(
        cls, *, conversation_id: str,
        turns: Mapping[str, Mapping[str, Any]] | Sequence[tuple[str, Mapping[str, Any], int]],
    ) -> "TurnLedger":
        """The one trusted constructor — see module note above on who may
        call it. ``turns`` is either a ``turn_id -> data`` mapping (the
        common case; Python dict order is the chronology, turn 0 first)
        or an explicit ``(turn_id, data, sequence)`` triple sequence for a
        caller whose own persistence layer hands turns to us already out
        of order but with its own real sequence numbers — ``build`` sorts
        by ``sequence``, never by argument/insertion order, either way."""
        if not conversation_id:
            raise ValueError("TurnLedger requires a non-empty conversation_id")
        resolved: list[tuple[str, dict, int]] = []
        if isinstance(turns, Mapping):
            for index, (turn_id, data) in enumerate(turns.items()):
                resolved.append((turn_id, dict(data or {}), index))
        else:
            for turn_id, data, sequence in turns:
                resolved.append((turn_id, dict(data or {}), sequence))
        seen: set[str] = set()
        verified: list[VerifiedTurn] = []
        for turn_id, data, sequence in resolved:
            if not isinstance(turn_id, str) or not turn_id:
                raise ValueError("every turn needs a non-empty string turn_id")
            if turn_id in seen:
                raise ValueError(f"duplicate turn_id in ledger: {turn_id!r}")
            if isinstance(sequence, bool) or not isinstance(sequence, int):
                raise ValueError(f"turn {turn_id!r} needs an int sequence")
            seen.add(turn_id)
            verified.append(VerifiedTurn(turn_id=turn_id, sequence=sequence, data=data))
        verified.sort(key=lambda t: t.sequence)
        return cls(conversation_id=conversation_id, turns=tuple(verified))

    @classmethod
    def empty(cls, conversation_id: str) -> "TurnLedger":
        """An EXPLICITLY empty ledger — "we checked this conversation's
        history and there genuinely isn't any" (e.g. this really is turn
        1). Deliberately distinct from passing ``turn_ledger=None``
        ("history was never consulted at all") — see ``validate_origin``
        and ``policy_compiler``'s missing-required-history handling."""
        return cls(conversation_id=conversation_id, turns=())

    def resolve(self, turn_id: str, *, conversation_id: str | None = None) -> VerifiedTurn | None:
        if conversation_id is not None and conversation_id != self.conversation_id:
            return None  # wrong ledger for this conversation
        for turn in self.turns:
            if turn.turn_id == turn_id:
                return turn
        return None


# ---------------------------------------------------------------------------
# Provenance validation (interpreter/compiler boundary).
# ---------------------------------------------------------------------------

def validate_origin(
    origin: Origin,
    *,
    original_message: str,
    turn_ledger: TurnLedger | None = None,
    conversation_id: str | None = None,
    viewer_context: Mapping[str, Any] | None = None,
) -> bool:
    """Is this one ``Origin`` trustworthy on its own?

    - ``current_message``: the span must be a real, in-bounds, non-empty
      slice of ``original_message``.
    - ``conversation_turn``: ``turn_id`` must resolve against the caller's
      own trusted ``TurnLedger`` (never a raw dict/mapping — see
      ``TurnLedger`` above) AND, when ``conversation_id`` is supplied,
      that ledger must be stamped for THIS SAME conversation (closes
      cross-conversation turn forgery). ``turn_ledger=None`` ("never
      checked") and an explicitly empty ``TurnLedger`` ("checked, found
      nothing") both fail to resolve here, as they must — but
      ``policy_compiler`` distinguishes the two at the point where it
      decides how to degrade safely, which is the behaviorally relevant
      place to tell them apart (see Decision 2 handoff notes).
    - ``viewer_metadata``: ``context_ref`` must resolve against the trusted
      viewer-context mapping, same idea.
    - ``unresolved``: never valid — it is the explicit "we don't know"
      marker, not a claim to verify.

    Note (field-level provenance limitation, intentionally NOT solved
    here — see docs/semantic-intent-milestone-3-plan.md): a verified
    ``turn_id`` proves this turn really happened and belongs to this
    conversation. It does NOT prove every individual
    ``ReleaseConstraints`` field the action claims was actually instructed
    AT that turn — the schema gives one action a single ``provenance``
    tuple covering its whole release bundle, not a per-field origin. A
    real turn's existence authenticates the ACTION's claim to reference
    that turn, not the truth of each field value riding along with it.
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
        return turn_ledger.resolve(origin.turn_id, conversation_id=conversation_id) is not None
    if origin.kind == "viewer_metadata":
        if not origin.context_ref or viewer_context is None:
            return False
        return origin.context_ref in viewer_context
    return False  # "unresolved" (or any future kind) is never self-valid.


def validate_action_provenance(
    action: Action,
    *,
    original_message: str,
    turn_ledger: TurnLedger | None = None,
    conversation_id: str | None = None,
    viewer_context: Mapping[str, Any] | None = None,
) -> Action:
    """An action whose provenance fails validation downgrades to
    ``state="unresolved"`` for that action — never a guess. An action with
    no provenance at all is left alone (provenance is optional; plenty of
    deterministic parses have none and are still trustworthy, e.g. an
    unambiguous explicit instruction the interpreter resolved directly).

    Requires EVERY origin to validate, not just one. The schema gives one
    action exactly one ``provenance`` tuple covering ALL of its fields —
    there is no per-field origin to point at — so a single valid origin
    (e.g. a real span justifying the target) must not be allowed to vouch
    for a DIFFERENT, unrelated claim riding along in the same tuple (e.g. a
    forged ``conversation_turn`` trying to justify an inherited
    prohibition). Requiring all-valid is the conservative reading that
    closes that gap without inventing per-field provenance the contract
    doesn't have."""
    if not action.provenance:
        return action
    if all(
        validate_origin(
            origin, original_message=original_message,
            turn_ledger=turn_ledger, conversation_id=conversation_id, viewer_context=viewer_context,
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
    turn_ledger: TurnLedger | None = None,
    conversation_id: str | None = None,
    viewer_context: Mapping[str, Any] | None = None,
) -> ResolvedStudentIntent:
    """Apply ``validate_action_provenance`` to every action in one intent."""
    from dataclasses import replace
    validated = tuple(
        validate_action_provenance(
            action, original_message=intent.original_message,
            turn_ledger=turn_ledger, conversation_id=conversation_id, viewer_context=viewer_context,
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
    "ReleaseForm", "ReleaseState", "ResolvedStudentIntent", "TurnLedger", "VerifiedTurn",
    "derive_primary_task", "derive_prohibited_tasks",
    "validate_action_provenance", "validate_intent_provenance", "validate_origin",
]

"""Milestone 2 — the pure, deterministic policy compiler.

Takes one ``ResolvedStudentIntent`` (``app/services/resolved_student_intent.
py``) and compiles it into one ``ExecutionPolicy``: a flat, per-target,
fully-resolved set of ``ReleaseConstraints`` a Milestone-3 consumer could
act on directly, with every ambiguity already resolved one specific way and
an audit trail recording why.

This module makes NO model calls and is NOT wired into any router,
generation, grounding, or persistence path — see the module docstring in
``resolved_student_intent.py`` for the same disclaimer. It is pure: same
input always produces the same ``ExecutionPolicy`` (including the same
``policy_hash``).

Conflict-resolution order (see the Milestone 1 design doc for the full
rationale, reproduced in short here because the implementation follows it
step by step):

1. Platform policy (hard filter, applied first) — ``PLATFORM_RULES`` below.
2. Within one target: a later turn wins over an earlier one, but only for
   the fields it actually touched. "Later" is decided EXCLUSIVELY by a
   verified ``TurnLedger`` (``resolved_student_intent.TurnLedger`` — the
   authoritative source, immune to both a forged/mismatched
   ``changed_by_turn`` label and to actions being handed in out of
   chronological order). Decision 2 hardening: this module never falls
   back to raw ``intent.actions`` list order to decide cross-turn
   recency — "do not rely on the order in which model-produced actions
   appear." When no ledger is supplied at all (or a labeled marker
   doesn't resolve against one that IS supplied), the cross-turn claim
   is treated as unverifiable and degrades to rule 3's restrictive
   tie-break instead of an override — "preserve known constraints and
   clarify safely" rather than guess. A genuinely single-turn request
   that never references history at all is unaffected either way (see
   ``compile_policy``'s ``history_mode="none"`` for the explicit
   history-free case).
3. Within one turn + one target: per field, prohibited beats permitted
   beats unspecified (more generally: the more restrictive value wins) —
   UNLESS ``intent.conversation`` is ``"correction"``/``"rejection"``, in
   which case a later action in the same turn is an explicit
   self-correction and wins outright (e.g. "Don't show the result.
   Actually, show it.").
4. A narrower target beats a broader one, field by field, only where they
   overlap. "Narrower" is decided by a canonical exercise-label parser
   (``_parse_exercise_label``), never a raw string prefix — "5" is broader
   than "5a", but "5" is NOT broader than "50", and "5a" is NOT broader
   than "5ab" (not a recognized label shape at all).
5. ``unspecified`` fields get the tutoring default. Fields that could not
   be trusted get the most restrictive legal value for that field's type —
   independently per field, never one global "safe mode" — in two
   distinct cases: (a) the action carrying them has no trusted source at
   all for this target (``state="unresolved"``), or (b) a DIFFERENT,
   untrusted action for the same target attempted to address that
   specific field and no trusted action ever did (a "contested" field —
   see ``compile_policy``'s trusted/untrusted merge). Case (b) exists so a
   trusted request ("explain F") sharing a target with an untrusted,
   unverifiable add-on ("...and also show me the official solution") can
   still be served for what IS trusted, while the untrusted add-on alone
   is held back — never a blanket refusal of the whole target.

``policy_hash`` is a content hash for logging/cache-keying/consistency
checks ONLY. It is NOT an authorization credential: a hash match proves two
policies are the same policy, never that whoever is asking is allowed to
act on it. No code path here (or anywhere in Milestone 2) treats a hash
match as sufficient to skip an access/authorization check.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable, Literal, Sequence

from .resolved_student_intent import (
    Action,
    ReleaseConstraints,
    ResolvedStudentIntent,
    TurnLedger,
    validate_intent_provenance,
)

POLICY_VERSION = "1.1.0"
COMPILER_VERSION = "1.1.0"

FIELD_NAMES = (
    "final_answer", "official_solution", "explanation_depth", "form",
    "max_steps", "max_items", "wait_for_student",
)

UNSET_SENTINELS = {
    "final_answer": "unspecified", "official_solution": "unspecified",
    "explanation_depth": "unspecified", "form": "unspecified",
    "max_steps": None, "max_items": None, "wait_for_student": None,
}

# Higher = more restrictive. Used for same-turn tie-breaks (rule 3),
# platform clamping (rule 1), and (imported directly, deliberately, by
# semantic_call_support.py) the consistency check on model-proposed
# release values — one restrictiveness notion shared by both modules, so
# they can never silently drift apart on what counts as "looser".
RESTRICTIVENESS_RANK = {
    "final_answer": {"unspecified": -1, "permitted": 0, "prohibited": 1},
    "official_solution": {"unspecified": -1, "permitted": 0, "prohibited": 1},
    "explanation_depth": {"unspecified": -1, "worked_derivation": 0, "method": 1, "concept": 2, "none": 3},
    "form": {"unspecified": -1, "worked_solution": 0, "explanation": 1, "guided_questions": 2, "hint": 3},
}

_MOST_RESTRICTIVE = {
    "final_answer": "prohibited", "official_solution": "prohibited",
    "explanation_depth": "none", "form": "hint",
    "max_steps": 1, "max_items": 1, "wait_for_student": True,
}

_TUTORING_DEFAULT = {
    # final_answer: ordinary tutoring behavior is to answer unless told
    # not to. official_solution is more sensitive — handing over the
    # instructor's own answer key — so it defaults closed and must be
    # explicitly requested (an action whose own release sets it
    # "permitted") rather than assumed from silence (case G: a quoted
    # instruction mentioning "the solution" must never default it open).
    "final_answer": "permitted", "official_solution": "prohibited",
    "explanation_depth": "method", "form": "explanation",
    "max_steps": None, "max_items": None, "wait_for_student": False,
}


def is_unset_field(field: str, value: Any) -> bool:
    return value == UNSET_SENTINELS[field]


def more_restrictive(field: str, a: Any, b: Any) -> Any:
    """Of two SET (non-unspecified) values for ``field``, return the more
    restrictive one. Used for same-turn conflicts (rule 3), platform
    clamping (rule 1), and (by ``semantic_call_support.py``) the
    never-loosen-a-trusted-prohibition consistency check."""
    if field in RESTRICTIVENESS_RANK:
        return a if RESTRICTIVENESS_RANK[field][a] >= RESTRICTIVENESS_RANK[field][b] else b
    if field in ("max_steps", "max_items"):
        if a is None:
            return b
        if b is None:
            return a
        return min(a, b)
    if field == "wait_for_student":
        return bool(a) or bool(b)
    raise KeyError(field)  # pragma: no cover - defensive, all fields covered above


# ---------------------------------------------------------------------------
# Platform policy — mechanism only. The approved rule set is empty: this
# project's product owner has not approved any NEW refusal category beyond
# what document access / exam-answer-key confidentiality already enforce
# elsewhere in the codebase (course_grounding.py, answer_intent.py). Do not
# add rules here speculatively — this is the extension point for when a
# rule IS approved, not a place to invent one.
# ponytail: empty list rather than a config system, because there is
# nothing to configure yet. Add a real entry (with its own test) the day a
# rule is actually approved.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PlatformRule:
    rule_id: str
    version: str
    field: str
    forced_value: Any
    predicate: Callable[[str, Action, ResolvedStudentIntent], bool]


PLATFORM_RULES: tuple[PlatformRule, ...] = ()


@dataclass(frozen=True)
class ExecutionPolicy:
    actions: tuple[Action, ...]
    evidence_requirements: tuple[str, ...]
    needs_clarification: bool
    clarification_question: str | None
    response_language: str
    response_language_reason: str
    platform_policy_applied: tuple[str, ...]
    policy_version: str
    compiler_version: str
    policy_hash: str


# ---------------------------------------------------------------------------
# Turn recency — see module docstring, rule 2. Deliberately NOT based on
# comparing marker strings' content or trusting raw list order by default.
# ---------------------------------------------------------------------------

_CURRENT_TURN_MARKER = "__current_turn__"


def _turn_marker(action: Action) -> str:
    if action.release.changed_by_turn:
        return action.release.changed_by_turn
    for origin in action.provenance:
        if origin.kind == "conversation_turn" and origin.turn_id:
            return origin.turn_id
    return _CURRENT_TURN_MARKER


def _resolve_turn_rank(
    marker: str, turn_ledger: TurnLedger | None, conversation_id: str | None,
) -> tuple[Any, bool]:
    """Returns ``(rank, forged)``. ``rank`` is a comparable recency value
    (higher = later) or ``None`` when it can't be verified. ``forged`` is
    True only when a ledger WAS supplied (even an explicitly empty one —
    see ``TurnLedger.empty``) and this specific, non-default marker could
    not be resolved against it (including a cross-conversation mismatch —
    see ``TurnLedger.resolve``) — an active, checkable claim that turned
    out false, not merely "we have no information". Without ANY ledger
    (``turn_ledger is None`` — "history was never consulted", distinct
    from an explicitly empty one), nothing gets a rank at all, not even
    the current-turn sentinel."""
    if turn_ledger is None:
        return None, False
    if marker == _CURRENT_TURN_MARKER:
        return float("inf"), False
    turn = turn_ledger.resolve(marker, conversation_id=conversation_id)
    if turn is not None:
        return turn.sequence, False
    return None, True


def _decide_field_override(
    *, old_marker: str, old_index: int, new_marker: str, new_index: int,
    turn_ledger: TurnLedger | None, conversation_id: str | None, correction_mode: bool,
) -> str:
    """Returns ``"override"`` (new value replaces old), ``"keep"`` (old
    value stands), ``"tie_break"`` (same-turn, no correction signal —
    more-restrictive wins), ``"tie_break_forged"`` (a ledger WAS supplied
    but this marker doesn't resolve against it — an active, checkable
    claim that turned out false), or ``"tie_break_missing_history"`` (no
    ledger was supplied at all, so a real cross-turn claim can't be
    verified either way).

    Decision 2 hardening: recency is NEVER taken from the markers' raw
    string content, and NEVER from blind input-list order, in any branch
    — "do not rely on the order in which model-produced actions appear."
    A verified ``turn_ledger`` is the only source of true recency; without
    one, an unresolvable cross-turn claim degrades to the SAME
    restrictive tie-break a forged one would get (never an override, never
    a position-based guess) — "preserve known constraints and clarify
    safely instead" rather than silently trusting whichever action
    happened to come later in the list."""
    if old_marker == new_marker:
        # Same turn. An explicit correction/rejection turn means the LATER
        # clause in the message is the student overriding themselves
        # ("don't show the result. Actually, show it.") — it wins outright,
        # the same way a later separate turn would. Otherwise this is a
        # genuinely ambiguous same-turn conflict with no "which one is the
        # correction" signal, so the safe default (rule 3) applies.
        return "override" if correction_mode else "tie_break"
    old_rank, old_forged = _resolve_turn_rank(old_marker, turn_ledger, conversation_id)
    new_rank, new_forged = _resolve_turn_rank(new_marker, turn_ledger, conversation_id)
    if new_forged:
        return "tie_break_forged"
    if old_forged:
        return "override"  # what we're up against turned out to be forged; the new, unforged claim stands on its own
    if old_rank is not None and new_rank is not None:
        return "override" if new_rank > old_rank else "keep"
    # Neither side has a verifiable rank: this only happens when no ledger
    # was supplied at all (a supplied ledger — even empty — always gives
    # the current-turn sentinel a rank, so one of old_rank/new_rank would
    # already be set above). History was required to settle this
    # cross-turn claim and is unavailable — never fall back to list order.
    return "tie_break_missing_history"


def _state_rank(state: str) -> int:
    return {"unspecified": 0, "unresolved": 1, "requested": 2, "prohibited": 3}.get(state, 0)


@dataclass
class _MergedTarget:
    working: dict[str, Any]
    final_state: str
    provenance: tuple
    primary: Action | None
    prohibited_objectives: frozenset[str]
    contested_fields: frozenset[str]
    missing_history_fields: frozenset[str]
    forged_turn_fields: frozenset[str]


def _merge_group(
    target: str, group: list[Action], turn_ledger: TurnLedger | None,
    conversation_id: str | None, correction_mode: bool,
) -> _MergedTarget:
    """Merge every action targeting ``target`` into one working dict of
    field values, applying rules 2 and 3.

    Trust boundary (hardening fix): only TRUSTED actions
    (``state != "unresolved"``) ever contribute a field value, determine
    the compiled ``objective``/``state``, or stand in for the whole
    target. An untrusted action can still make itself KNOWN — its
    objective is recorded in ``prohibited_objectives`` and the specific
    fields it tried to touch are recorded in ``contested_fields`` (so the
    caller can fall back those particular fields to the restrictive
    default instead of the tutoring default) — but it can never leak a
    value, an objective, or a state into the compiled result."""
    working: dict[str, Any] = dict(UNSET_SENTINELS)
    touched_turn: dict[str, str] = {}
    touched_index: dict[str, int] = {}
    provenance: list = []
    trusted: list[Action] = []
    untrusted: list[Action] = []
    missing_history_fields: set[str] = set()
    forged_turn_fields: set[str] = set()

    for action in group:
        provenance.extend(action.provenance)
        (untrusted if action.state == "unresolved" else trusted).append(action)

    for idx, action in enumerate(group):
        if action.state == "unresolved":
            continue
        turn = _turn_marker(action)
        for field in FIELD_NAMES:
            new_val = getattr(action.release, field)
            if is_unset_field(field, new_val):
                continue
            if is_unset_field(field, working[field]):
                working[field] = new_val
                touched_turn[field] = turn
                touched_index[field] = idx
                continue
            decision = _decide_field_override(
                old_marker=touched_turn[field], old_index=touched_index[field],
                new_marker=turn, new_index=idx,
                turn_ledger=turn_ledger, conversation_id=conversation_id, correction_mode=correction_mode,
            )
            if decision == "override":
                working[field] = new_val
                touched_turn[field] = turn
                touched_index[field] = idx
            elif decision in ("tie_break", "tie_break_forged", "tie_break_missing_history"):
                working[field] = more_restrictive(field, working[field], new_val)
                if decision == "tie_break_forged":
                    forged_turn_fields.add(field)
                elif decision == "tie_break_missing_history":
                    missing_history_fields.add(field)
            # "keep": old value stands, nothing to do.

    # Untrusted attempts are surfaced, never silently merged: which fields
    # they tried to touch (that no trusted action also set — a trusted
    # field always wins, per "preserve independently established trusted
    # fields"), and which objective they were for.
    contested_fields = {
        field for action in untrusted for field in FIELD_NAMES
        if not is_unset_field(field, getattr(action.release, field)) and is_unset_field(field, working[field])
    }
    untrusted_objectives = {action.objective for action in untrusted}

    if trusted:
        requested = [a for a in trusted if a.state != "prohibited"]
        primary = requested[-1] if requested else trusted[-1]
        final_state = primary.state
        prohibited_objectives = {a.objective for a in trusted if a.state == "prohibited"}
        for a in trusted:
            prohibited_objectives.update(a.prohibited)
        prohibited_objectives.discard(primary.objective)
    else:
        primary = group[-1] if group else None
        final_state = "unresolved"
        prohibited_objectives = set()

    # Untrusted objectives are not confirmed prohibitions (the student
    # never said no) — but they are not authorized either, so they are
    # surfaced the same way: "not currently permitted", distinct from a
    # target-wide refusal.
    all_prohibited = frozenset(prohibited_objectives | untrusted_objectives) - ({primary.objective} if primary else set())

    return _MergedTarget(
        working=working, final_state=final_state, provenance=tuple(provenance),
        primary=primary, prohibited_objectives=all_prohibited, contested_fields=frozenset(contested_fields),
        missing_history_fields=frozenset(missing_history_fields), forged_turn_fields=frozenset(forged_turn_fields),
    )


# ---------------------------------------------------------------------------
# Exercise-label hierarchy (rule 4) — a real canonical parser, not a raw
# string prefix. Covers "<number>[<letter>[<number>]]" (e.g. "5", "5a",
# "5a1") — the shape actually seen in the fixtures. A label that doesn't
# match this grammar (e.g. "F", "task", "quoted_instruction") is an opaque
# identifier with NO inferred relationship to anything else.
# ponytail: one grammar, not a general label DSL — extend
# _EXERCISE_LABEL_RE the day a real label family (e.g. "Teil B", roman
# numerals) actually needs it.
# ---------------------------------------------------------------------------

_EXERCISE_LABEL_RE = re.compile(r"^(\d+)([a-zA-Z]?)(\d*)$")


def _parse_exercise_label(label: str) -> tuple | None:
    match = _EXERCISE_LABEL_RE.match(label.strip())
    if not match:
        return None
    number, letter, sub_number = match.groups()
    segments: list[tuple[str, Any]] = [("num", int(number))]
    if letter:
        segments.append(("alpha", letter.lower()))
    if sub_number:
        segments.append(("num", int(sub_number)))
    return tuple(segments)


def _is_broader(candidate: str, target: str) -> bool:
    """True only if ``target``'s canonical label segments are a strict,
    well-formed extension of ``candidate``'s (e.g. "5" vs "5a", "5a" vs
    "5a1"). Never true for labels that don't both parse as the recognized
    exercise-label grammar ("F" vs "Fx"), and never true for same-length
    labels that merely share a prefix ("5" vs "50", "5a" vs "5ab" — "5ab"
    doesn't even parse, since it has two letters)."""
    if candidate == target:
        return False
    candidate_segments = _parse_exercise_label(candidate)
    target_segments = _parse_exercise_label(target)
    if candidate_segments is None or target_segments is None:
        return False
    return (
        len(target_segments) > len(candidate_segments)
        and target_segments[: len(candidate_segments)] == candidate_segments
    )


def compile_policy(
    intent: ResolvedStudentIntent,
    *,
    turn_ledger: TurnLedger | None = None,
    conversation_id: str | None = None,
    history_mode: Literal["ledger", "none"] = "ledger",
    viewer_context: dict[str, Any] | None = None,
    platform_rules: Sequence[PlatformRule] = PLATFORM_RULES,
) -> ExecutionPolicy:
    """Compile one ``ResolvedStudentIntent`` into one ``ExecutionPolicy``.

    ``turn_ledger`` (Decision 2 hardening) must be a
    ``resolved_student_intent.TurnLedger`` — the one trusted constructor,
    built by the application boundary from ITS OWN persistence, never
    accepted blindly from model output or client-supplied turn metadata.
    A plain dict/mapping is no longer accepted here at all.

    Three distinct states, all meaningfully different:

    - ``turn_ledger=None`` (default, ``history_mode="ledger"``): history
      was never consulted. If the intent turns out to reference a
      cross-turn claim anyway (a ``changed_by_turn``/``conversation_turn``
      marker competing against another for the same field), that claim
      is UNVERIFIABLE — it degrades to the restrictive tie-break (rule 3),
      never an override, never a position-based guess, and the affected
      target is flagged ``needs_clarification`` ("preserve known
      constraints and clarify safely instead" rather than silently
      trusting whichever action happened to come later in the list).
    - ``turn_ledger=TurnLedger.empty(conversation_id)``: history WAS
      checked and there genuinely isn't any (e.g. this really is turn 1).
      A labeled marker still won't resolve against it (nothing to find),
      but this is the ordinary "turn doesn't exist" outcome, not a
      "we never checked" one — see the forged-vs-missing-history audit
      tags below for how a caller can tell them apart after the fact.
    - ``turn_ledger=TurnLedger.build(...)`` with real turns: recency comes
      from the ledger's own verified chronology, immune to both a
      forged/mismatched ``changed_by_turn`` label and to actions being
      handed to this function out of chronological order.

    ``history_mode="none"`` is the explicit history-free mode for a truly
    single-turn request: it forces ``turn_ledger`` to ``None`` regardless
    of what was passed, so a caller who already knows there is no prior
    conversation doesn't need to construct an empty ledger just to say so.

    ``conversation_id``, when supplied, must match the ledger's own
    stamped ``conversation_id`` for any turn to resolve — a turn_id that
    is real in a DIFFERENT conversation's ledger never resolves here
    (cross-conversation turn forgery).

    Known, intentionally out-of-scope limitation (see
    docs/semantic-intent-milestone-3-plan.md): a verified turn_id proves
    the ACTION's claim to reference that turn, not that every individual
    ``ReleaseConstraints`` field it carries was truly instructed at that
    turn — the schema has one ``provenance``/``changed_by_turn`` per
    action, not per field. Full field-level provenance would need a
    schema change, not a compiler change; this module does not attempt
    one and does not pretend otherwise.
    """
    if history_mode == "none":
        turn_ledger = None
    # Provenance validation happens first: an action whose provenance
    # fails to resolve against the trusted ledger/context downgrades to
    # state="unresolved" right here, before any merging.
    intent = validate_intent_provenance(
        intent, turn_ledger=turn_ledger, conversation_id=conversation_id, viewer_context=viewer_context,
    )
    correction_mode = intent.conversation in {"correction", "rejection"}

    audit: list[str] = []
    groups: dict[str, list[Action]] = {}
    for action in intent.actions:
        groups.setdefault(action.target, []).append(action)

    merged_by_target: dict[str, _MergedTarget] = {
        target: _merge_group(target, group, turn_ledger, conversation_id, correction_mode)
        for target, group in groups.items()
    }

    # Rule 4: narrower target inherits untouched fields from its closest
    # broader parent, field by field. Skipped entirely for exercise_switch
    # turns — a switch means "treat the new target fresh", not "carry the
    # old label's constraints under a new name" (case F).
    if intent.conversation != "exercise_switch":
        for target, merged in merged_by_target.items():
            parents = sorted(
                (t for t in merged_by_target if _is_broader(t, target)),
                key=len, reverse=True,
            )
            for parent in parents:
                parent_working = merged_by_target[parent].working
                for field in FIELD_NAMES:
                    if is_unset_field(field, merged.working[field]) and not is_unset_field(field, parent_working[field]):
                        merged.working[field] = parent_working[field]
                        audit.append(f"narrow_target_inherits:{target}<-{parent}:{field}")

    # Rule 1: platform policy, applied as a hard clamp so a prohibited
    # field can never come out looser than the rule demands, regardless of
    # merge order.
    applied_platform: list[str] = []
    for target, group in groups.items():
        working = merged_by_target[target].working
        for rule in platform_rules:
            if any(rule.predicate(target, action, intent) for action in group):
                current = working[rule.field]
                if is_unset_field(rule.field, current):
                    working[rule.field] = rule.forced_value
                else:
                    working[rule.field] = more_restrictive(rule.field, current, rule.forced_value)
                applied_platform.append(f"platform_rule:{rule.rule_id}@{rule.version}:{target}:{rule.field}")

    # Rule 5: fallback. A field left unset after all of the above gets the
    # tutoring default, UNLESS it was either (a) never trusted for this
    # target at all (state="unresolved") or (b) specifically contested by
    # an untrusted action with no trusted action ever addressing it — both
    # get the most restrictive legal value, strictly per field.
    compiled_actions: list[Action] = []
    needs_clarification = False
    for target, merged in merged_by_target.items():
        working = merged.working
        state = merged.final_state
        if state == "unresolved" or merged.contested_fields or merged.missing_history_fields or merged.forged_turn_fields:
            needs_clarification = True
        for field in merged.missing_history_fields:
            audit.append(f"missing_required_history:{target}:{field}")
        for field in merged.forged_turn_fields:
            audit.append(f"forged_turn_marker:{target}:{field}")
        for field in FIELD_NAMES:
            if not is_unset_field(field, working[field]):
                continue
            if state == "unresolved" or field in merged.contested_fields:
                working[field] = _MOST_RESTRICTIVE[field]
                tag = "unresolved_fallback" if state == "unresolved" else "contested_fallback"
                audit.append(f"{tag}:{target}:{field}={working[field]!r}")
            else:
                working[field] = _TUTORING_DEFAULT[field]
                audit.append(f"tutoring_default:{target}:{field}={working[field]!r}")
        release = ReleaseConstraints(**{f: working[f] for f in FIELD_NAMES})
        base_action = merged.primary if merged.primary is not None else Action(objective="other", target=target)
        compiled_actions.append(replace(
            base_action, release=release, state=state, provenance=merged.provenance,
            prohibited=tuple(sorted(merged.prohibited_objectives)),
        ))

    clarification_question = (
        "Could you confirm exactly what you'd like for this exercise — I want to "
        "make sure I don't show you something you asked me not to."
        if needs_clarification else None
    )

    evidence_requirements = tuple(sorted({
        "course_grounding_required"
        for a in compiled_actions
        if a.objective in {"official_solution", "exam_practice", "review_student_solution"}
    }))

    response_language, response_language_reason = _resolve_response_language(intent, turn_ledger, conversation_id)

    platform_policy_applied = tuple(applied_platform + audit)
    policy_hash = compute_policy_hash(
        actions=tuple(compiled_actions),
        response_language=response_language,
        evidence_requirements=evidence_requirements,
        platform_policy_applied=platform_policy_applied,
        policy_version=POLICY_VERSION,
        compiler_version=COMPILER_VERSION,
    )

    return ExecutionPolicy(
        actions=tuple(compiled_actions),
        evidence_requirements=evidence_requirements,
        needs_clarification=needs_clarification,
        clarification_question=clarification_question,
        response_language=response_language,
        response_language_reason=response_language_reason,
        platform_policy_applied=platform_policy_applied,
        policy_version=POLICY_VERSION,
        compiler_version=COMPILER_VERSION,
        policy_hash=policy_hash,
    )


def _resolve_response_language(
    intent: ResolvedStudentIntent, turn_ledger: TurnLedger | None, conversation_id: str | None,
) -> tuple[str, str]:
    """``response_language`` is carried verbatim from the resolved intent
    (Milestone 3's interpreter is what actually decides it); the compiler
    only explains WHY, for the audit trail — distinguishing an explicit
    instruction persisted from an earlier turn (via a validated
    ``conversation_turn`` origin, resolved against the trusted
    ``TurnLedger``) from one set on the current turn."""
    if turn_ledger is not None:
        for action in intent.actions:
            for origin in action.provenance:
                if origin.kind != "conversation_turn" or not origin.turn_id:
                    continue
                turn = turn_ledger.resolve(origin.turn_id, conversation_id=conversation_id)
                if turn is not None and turn.data.get("response_language") == intent.response_language:
                    return intent.response_language, f"persisted_explicit_instruction:turn={origin.turn_id}"
    if intent.response_language:
        return intent.response_language, "explicit_current_turn"
    return "unspecified", "default"


def compute_policy_hash(
    *, actions: tuple[Action, ...], response_language: str,
    evidence_requirements: tuple[str, ...] = (),
    platform_policy_applied: tuple[str, ...], policy_version: str, compiler_version: str,
) -> str:
    """Deterministic content hash — logging/cache-keying/consistency only,
    NEVER an authorization credential (see module docstring).

    Covers every field that is both materially behavior-relevant AND
    independently re-derivable from ``ExecutionPolicy`` alone (so a
    "second consumer" with only the serialized policy in hand can always
    recompute it — see test_policy_compiler.py's integration tests):
    ``actions`` (constraints + target/objective/prohibited identities),
    ``response_language``, ``evidence_requirements`` (added by this
    hardening pass — two policies that differ only in whether course
    grounding is required must never collide on one cache key),
    ``platform_policy_applied`` (which rule ids/versions fired and why),
    ``policy_version``, ``compiler_version``.

    Deliberately EXCLUDES ``ResolvedStudentIntent.schema_version`` (the
    *input* contract's version): ``ExecutionPolicy`` does not carry that
    value forward as a field, so including it in the hash would make the
    hash depend on something no downstream consumer could ever
    independently recompute from the policy object alone — breaking the
    exact "safe hand-off" property this hash exists for. An input schema
    change is expected to show up as a ``compiler_version``/
    ``policy_version`` bump instead, both of which ARE in the hash.
    """
    payload = {
        "actions": [asdict(a) for a in actions],
        "response_language": response_language,
        "evidence_requirements": list(evidence_requirements),
        "platform_policy_applied": list(platform_policy_applied),
        "policy_version": policy_version,
        "compiler_version": compiler_version,
    }
    canonical = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def extract_persistable_restrictions(policy: ExecutionPolicy) -> dict[str, dict[str, Any]]:
    """Capture, per target, only the release fields a compiled policy
    resolved to something OTHER than the ordinary tutoring default --
    i.e. a genuine, trusted deviation (an explicit prohibition/
    permission, or a restrictive degrade from an unresolved/contested
    field), never a routine default silently baked in. This is the one
    thing safe to persist (into the turn's existing ``ai_tutor_requests.
    request_snapshot`` JSONB column -- see semantic_intent_orchestrator.
    py's multi-turn persistence) and replay into a LATER turn's
    ``compile_policy`` call as a reconstructed historical ``Action``,
    without that later turn inheriting defaults it was never actually
    told about. A field equal to its tutoring default is omitted -- even
    if some action explicitly set it to exactly that value, replaying it
    changes nothing, so there is nothing worth the storage. Degenerate
    inputs (no actions, nothing deviates) return ``{}``."""
    out: dict[str, dict[str, Any]] = {}
    for action in policy.actions:
        deviations = {
            field: getattr(action.release, field)
            for field in FIELD_NAMES
            if getattr(action.release, field) != _TUTORING_DEFAULT[field]
        }
        if deviations:
            out[action.target] = deviations
    return out


__all__ = [
    "COMPILER_VERSION", "FIELD_NAMES", "POLICY_VERSION", "RESTRICTIVENESS_RANK",
    "ExecutionPolicy", "PLATFORM_RULES", "PlatformRule", "UNSET_SENTINELS",
    "compile_policy", "compute_policy_hash", "extract_persistable_restrictions",
    "is_unset_field", "more_restrictive",
]

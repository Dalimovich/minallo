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
   the fields it actually touched.
3. Within one turn + one target: per field, prohibited beats permitted
   beats unspecified (more generally: the more restrictive value wins).
4. A narrower target beats a broader one, field by field, only where they
   overlap.
5. ``unspecified`` fields get the tutoring default. Fields that could not
   be trusted (the action carrying them is ``state="unresolved"``, e.g.
   because its only provenance failed validation) get the most restrictive
   legal value for that field's type — independently per field, never one
   global "safe mode".

``policy_hash`` is a content hash for logging/cache-keying/consistency
checks ONLY. It is NOT an authorization credential: a hash match proves two
policies are the same policy, never that whoever is asking is allowed to
act on it. No code path here (or anywhere in Milestone 2) treats a hash
match as sufficient to skip an access/authorization check.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable, Sequence

from .resolved_student_intent import (
    Action,
    ReleaseConstraints,
    ResolvedStudentIntent,
    validate_intent_provenance,
)

POLICY_VERSION = "1.0.0"
COMPILER_VERSION = "1.0.0"

_FIELD_NAMES = (
    "final_answer", "official_solution", "explanation_depth", "form",
    "max_steps", "max_items", "wait_for_student",
)

_UNSET = {
    "final_answer": "unspecified", "official_solution": "unspecified",
    "explanation_depth": "unspecified", "form": "unspecified",
    "max_steps": None, "max_items": None, "wait_for_student": None,
}

# Higher = more restrictive. Used both for same-turn tie-breaks (rule 3) and
# for clamping under a platform rule (rule 1 — never loosen downstream).
_RANK = {
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


def _is_unset(field: str, value: Any) -> bool:
    return value == _UNSET[field]


def _more_restrictive(field: str, a: Any, b: Any) -> Any:
    """Of two SET (non-unspecified) values for ``field``, return the more
    restrictive one. Used for same-turn conflicts (rule 3) and for platform
    clamping (rule 1)."""
    if field in _RANK:
        return a if _RANK[field][a] >= _RANK[field][b] else b
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


def _turn_marker(action: Action) -> str:
    if action.release.changed_by_turn:
        return action.release.changed_by_turn
    for origin in action.provenance:
        if origin.kind == "conversation_turn" and origin.turn_id:
            return origin.turn_id
    return "__current_turn__"


def _state_rank(state: str) -> int:
    return {"unspecified": 0, "unresolved": 1, "requested": 2, "prohibited": 3}.get(state, 0)


def _merge_group(
    target: str, group: list[Action], audit: list[str],
) -> tuple[dict[str, Any], str, tuple]:
    """Merge every action targeting ``target`` into one working dict of
    field values, applying rules 2 and 3. Only TRUSTED actions
    (``state != "unresolved"``) ever contribute a field value — an
    untrusted action's own guess must never leak into the merged result
    (that is exactly what being untrusted means)."""
    working: dict[str, Any] = dict(_UNSET)
    touched_turn: dict[str, str] = {}
    any_untrusted = False
    final_state = "unspecified"
    provenance: list = []
    for action in group:
        provenance.extend(action.provenance)
        if action.state == "unresolved":
            any_untrusted = True
            continue
        turn = _turn_marker(action)
        for field in _FIELD_NAMES:
            new_val = getattr(action.release, field)
            if _is_unset(field, new_val):
                continue
            if _is_unset(field, working[field]):
                working[field] = new_val
                touched_turn[field] = turn
                continue
            if touched_turn.get(field) == turn:
                working[field] = _more_restrictive(field, working[field], new_val)
            else:
                # Different (later) turn touching the same field: the newer
                # instruction wins outright (rule 2), even if that LOOSENS
                # an earlier prohibition — e.g. case E lifting a prior
                # "don't calculate" once the student explicitly asks for it.
                working[field] = new_val
                touched_turn[field] = turn
        if _state_rank(action.state) >= _state_rank(final_state):
            final_state = action.state
    if any_untrusted and final_state == "unspecified":
        final_state = "unresolved"
    return working, final_state, tuple(provenance)


def _is_broader(candidate: str, target: str) -> bool:
    """Minimal hierarchical-label heuristic (e.g. "5" is broader than
    "5a"/"5b"): a prefix match, nothing fancier. Siblings ("5a" vs "5b")
    never match each other this way, which is exactly what keeps an
    exercise-switch from accidentally inheriting a sibling's constraints.
    ponytail: prefix check, not a real exercise-label grammar — upgrade if
    non-prefix label families (e.g. "Teil B") need this too."""
    candidate = candidate.strip()
    return bool(candidate) and candidate != target and target.lower().startswith(candidate.lower())


def compile_policy(
    intent: ResolvedStudentIntent,
    *,
    turn_ledger: dict[str, Any] | None = None,
    viewer_context: dict[str, Any] | None = None,
    platform_rules: Sequence[PlatformRule] = PLATFORM_RULES,
) -> ExecutionPolicy:
    # Provenance validation happens first: an action whose only provenance
    # fails to resolve against the trusted ledger/context downgrades to
    # state="unresolved" right here, before any merging.
    intent = validate_intent_provenance(intent, turn_ledger=turn_ledger, viewer_context=viewer_context)

    audit: list[str] = []
    groups: dict[str, list[Action]] = {}
    for action in intent.actions:
        groups.setdefault(action.target, []).append(action)

    working_by_target: dict[str, dict[str, Any]] = {}
    state_by_target: dict[str, str] = {}
    provenance_by_target: dict[str, tuple] = {}
    for target, group in groups.items():
        working, state, provenance = _merge_group(target, group, audit)
        working_by_target[target] = working
        state_by_target[target] = state
        provenance_by_target[target] = provenance

    # Rule 4: narrower target inherits untouched fields from its closest
    # broader parent, field by field. Skipped entirely for exercise_switch
    # turns — a switch means "treat the new target fresh", not "carry the
    # old label's constraints under a new name" (case F).
    if intent.conversation != "exercise_switch":
        for target, working in working_by_target.items():
            parents = sorted(
                (t for t in working_by_target if _is_broader(t, target)),
                key=len, reverse=True,
            )
            for parent in parents:
                parent_working = working_by_target[parent]
                for field in _FIELD_NAMES:
                    if _is_unset(field, working[field]) and not _is_unset(field, parent_working[field]):
                        working[field] = parent_working[field]
                        audit.append(f"narrow_target_inherits:{target}<-{parent}:{field}")

    # Rule 1: platform policy, applied as a hard clamp so a prohibited
    # field can never come out looser than the rule demands, regardless of
    # merge order.
    applied_platform: list[str] = []
    for target, group in groups.items():
        working = working_by_target[target]
        for rule in platform_rules:
            if any(rule.predicate(target, action, intent) for action in group):
                current = working[rule.field]
                if _is_unset(rule.field, current):
                    working[rule.field] = rule.forced_value
                else:
                    working[rule.field] = _more_restrictive(rule.field, current, rule.forced_value)
                applied_platform.append(f"platform_rule:{rule.rule_id}@{rule.version}:{target}:{rule.field}")

    # Rule 5: fallback. A field left unset after all of the above gets
    # either the tutoring default (nothing untrustworthy happened — it was
    # simply never addressed) or the most restrictive legal value for its
    # type (this target had an untrusted/unresolved action and nothing
    # trusted ever set this field) — strictly per field, never a single
    # global "safe mode".
    compiled_actions: list[Action] = []
    for target, group in groups.items():
        working = working_by_target[target]
        state = state_by_target[target]
        for field in _FIELD_NAMES:
            if not _is_unset(field, working[field]):
                continue
            if state == "unresolved":
                working[field] = _MOST_RESTRICTIVE[field]
                audit.append(f"unresolved_fallback:{target}:{field}={working[field]!r}")
            else:
                working[field] = _TUTORING_DEFAULT[field]
                audit.append(f"tutoring_default:{target}:{field}={working[field]!r}")
        release = ReleaseConstraints(**{f: working[f] for f in _FIELD_NAMES})
        last = group[-1]
        compiled_actions.append(replace(
            last, release=release, state=state, provenance=provenance_by_target[target],
        ))

    needs_clarification = any(a.state == "unresolved" for a in compiled_actions)
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

    response_language, response_language_reason = _resolve_response_language(intent, turn_ledger)

    platform_policy_applied = tuple(applied_platform + audit)
    policy_hash = compute_policy_hash(
        actions=tuple(compiled_actions),
        response_language=response_language,
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
    intent: ResolvedStudentIntent, turn_ledger: dict[str, Any] | None,
) -> tuple[str, str]:
    """``response_language`` is carried verbatim from the resolved intent
    (Milestone 3's interpreter is what actually decides it); the compiler
    only explains WHY, for the audit trail — distinguishing an explicit
    instruction persisted from an earlier turn (via a validated
    ``conversation_turn`` origin) from one set on the current turn."""
    if turn_ledger:
        for action in intent.actions:
            for origin in action.provenance:
                if (
                    origin.kind == "conversation_turn"
                    and origin.turn_id in turn_ledger
                    and turn_ledger[origin.turn_id].get("response_language") == intent.response_language
                ):
                    return intent.response_language, f"persisted_explicit_instruction:turn={origin.turn_id}"
    if intent.response_language:
        return intent.response_language, "explicit_current_turn"
    return "unspecified", "default"


def compute_policy_hash(
    *, actions: tuple[Action, ...], response_language: str,
    platform_policy_applied: tuple[str, ...], policy_version: str, compiler_version: str,
) -> str:
    """Deterministic content hash — logging/cache-keying/consistency only,
    NEVER an authorization credential (see module docstring)."""
    payload = {
        "actions": [asdict(a) for a in actions],
        "response_language": response_language,
        "platform_policy_applied": list(platform_policy_applied),
        "policy_version": policy_version,
        "compiler_version": compiler_version,
    }
    canonical = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


__all__ = [
    "COMPILER_VERSION", "POLICY_VERSION", "ExecutionPolicy", "PLATFORM_RULES",
    "PlatformRule", "compile_policy", "compute_policy_hash",
]

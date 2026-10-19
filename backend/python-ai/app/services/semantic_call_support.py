"""Milestone 2 — pure support functions for the (future, Milestone 3) model
call that would populate ``ResolvedStudentIntent.actions``.

Two concerns, both pure / no network:

1. ``needs_semantic_escalation`` — the WIDENED trigger condition from the
   Milestone 1 design (any negation/prohibition cue in any language, more
   than one action/target, quotation marks or reported speech, a
   correction/rejection/exercise-switch, an unresolved reference, or a
   release-related word combined with any of the above). This is a trigger
   for calling the model, never the decision itself.

   Deliberately NOT wired into ``student_intent._needs_semantic_path`` —
   that function gates the LIVE (flag-gated) call #2 inside the existing
   ``interpret_student_intent``, and replacing its trigger logic would
   change an existing consumer's behavior, which is out of scope for
   Milestone 2 ("isolated foundations"). Milestone 3 is where this
   actually replaces ``_needs_semantic_path``.

2. ``validate_semantic_action`` — strict schema + consistency validation
   for one model-proposed action, mirroring ``student_intent._semantic_
   model_call``'s existing validation style (reject unknown enum values,
   missing/malformed fields, out-of-range confidence, UNKNOWN fields too —
   a model payload with an extra/misspelled key is rejected, not silently
   ignored) plus two consistency invariants, now checked across EVERY
   ``ReleaseConstraints`` field (final answer, official solution,
   explanation depth, form, and the pacing fields), not just the two
   release-state ones:

   - the model may ADD a restriction but may never REMOVE/loosen one the
     caller already trusts at high confidence (``base_action``);
   - the model may never grant anything a platform rule has already
     clamped (``platform_forbidden`` — a ``{field: forced_value}`` mapping
     the caller builds from whichever ``PlatformRule``s matched BEFORE
     calling this; see ``policy_compiler.PLATFORM_RULES``).

   Any failure returns ``None`` — fail-closed, never a propagated
   exception (including a malformed, non-dict ``release`` payload), never
   an expanded permission.

   Field-level provenance note: this function validates the PAYLOAD'S
   content only. Whether the caller should trust the resulting ``Action``
   AT ALL is a separate, mandatory question answered by
   ``resolved_student_intent.validate_action_provenance`` — which now
   requires EVERY origin in an action's ``provenance`` tuple to validate,
   not just one (see that module for why: the schema gives one action a
   single provenance tuple covering all of its fields, so a single valid
   origin must never be allowed to vouch for a different, unrelated claim
   riding along with it). Callers MUST run every ``Action`` this function
   returns through that provenance check before treating it as trusted —
   this function has no visibility into provenance at all.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, get_args

from .policy_compiler import FIELD_NAMES, is_unset_field, more_restrictive
from .resolved_student_intent import Action, ActionState, ExplanationDepth, Objective, ReleaseConstraints, ReleaseForm, ReleaseState

_NEGATION_RE = re.compile(
    r"\b(?:not|don't|do\s+not|without|never|no\b|nicht|kein\w*|ohne|لا|ما)\b", re.IGNORECASE,
)
_QUOTE_RE = re.compile(r"[\"'“”‘’]")
_REPORTED_SPEECH_RE = re.compile(r"\b(?:wrote|said|says|told|schrieb|sagte)\b", re.IGNORECASE)
_RELEASE_WORD_RE = re.compile(
    r"\b(?:solution|answer|result|musterl(?:ö|oe)sung|l(?:ö|oe)sung|ergebnis|antwort)\b", re.IGNORECASE,
)
_CORRECTION_RE = re.compile(
    r"\bi meant\b|\bactually\b|\bcorrection\b|\bich meinte\b|\bnein,\s*ich meinte\b", re.IGNORECASE,
)
# Two distinct exercise-like labels mentioned in one message (e.g. "Aufgabe
# 5" ... "Aufgabe 6") — a cheap proxy for "more than one action/target".
_TWO_TARGETS_RE = re.compile(
    r"(?:aufgabe|exercise|task)\s*\d+[a-z]?\b", re.IGNORECASE,
)


def needs_semantic_escalation(message: str, *, has_unresolved_reference: bool = False) -> bool:
    text = message or ""
    negation = bool(_NEGATION_RE.search(text))
    quoted_or_reported = bool(_QUOTE_RE.search(text) or _REPORTED_SPEECH_RE.search(text))
    corrective = bool(_CORRECTION_RE.search(text))
    multi_target = len(_TWO_TARGETS_RE.findall(text)) > 1
    if negation or quoted_or_reported or corrective or multi_target or has_unresolved_reference:
        return True
    # A release-related word alone is not enough — only combined with one of
    # the above cues (already all False here) does it trigger.
    return False


_RELEASE_STATE_VALUES = set(get_args(ReleaseState))
_EXPLANATION_DEPTH_VALUES = set(get_args(ExplanationDepth))
_RELEASE_FORM_VALUES = set(get_args(ReleaseForm))
_OBJECTIVE_VALUES = set(get_args(Objective))
_ACTION_STATE_VALUES = set(get_args(ActionState))

# changed_by_turn is deliberately NOT in this whitelist: it names which
# TRUSTED, deterministic turn a correction took effect at, which is a
# claim the model-sourced payload is never in a position to make on its
# own (see policy_compiler.py's turn-recency hardening) — a payload that
# includes it is rejected as an unknown field, not silently accepted.
_ALLOWED_RELEASE_KEYS = frozenset(FIELD_NAMES) - {"changed_by_turn"}
_ALLOWED_TOP_LEVEL_KEYS = frozenset({"objective", "target", "confidence", "release", "state", "prohibited"})
_MAX_REASONABLE_COUNT = 50  # max_steps/max_items ceiling — generous, not unlimited.


def _validated_release(raw: Mapping[str, Any]) -> ReleaseConstraints:
    if not isinstance(raw, Mapping):
        raise ValueError("release must be an object")
    unknown = set(raw.keys()) - _ALLOWED_RELEASE_KEYS
    if unknown:
        raise ValueError(f"release has unknown field(s): {sorted(unknown)}")

    final_answer = raw.get("final_answer", "unspecified")
    official_solution = raw.get("official_solution", "unspecified")
    explanation_depth = raw.get("explanation_depth", "unspecified")
    form = raw.get("form", "unspecified")
    max_steps = raw.get("max_steps")
    max_items = raw.get("max_items")
    wait_for_student = raw.get("wait_for_student")
    if final_answer not in _RELEASE_STATE_VALUES:
        raise ValueError("final_answer must be a known ReleaseState value")
    if official_solution not in _RELEASE_STATE_VALUES:
        raise ValueError("official_solution must be a known ReleaseState value")
    if explanation_depth not in _EXPLANATION_DEPTH_VALUES:
        raise ValueError("explanation_depth must be a known value")
    if form not in _RELEASE_FORM_VALUES:
        raise ValueError("form must be a known value")
    for count_field, value in (("max_steps", max_steps), ("max_items", max_items)):
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{count_field} must be an int or null")
        if not 1 <= value <= _MAX_REASONABLE_COUNT:
            raise ValueError(f"{count_field} must be between 1 and {_MAX_REASONABLE_COUNT}")
    if wait_for_student is not None and not isinstance(wait_for_student, bool):
        raise ValueError("wait_for_student must be a bool or null")
    return ReleaseConstraints(
        final_answer=final_answer, official_solution=official_solution,
        explanation_depth=explanation_depth, form=form,
        max_steps=max_steps, max_items=max_items, wait_for_student=wait_for_student,
    )


def _violates_restrictiveness_floor(field: str, floor_value: Any, proposed_value: Any) -> bool:
    """True if ``proposed_value`` is strictly LESS restrictive than
    ``floor_value`` for ``field`` — i.e. the proposal would loosen past a
    value the caller is holding as a floor (a trusted base action's own
    value, or a platform-forced value)."""
    if is_unset_field(field, floor_value):
        return False  # no floor to violate
    if is_unset_field(field, proposed_value):
        return False  # the model didn't address this field at all
    more = more_restrictive(field, floor_value, proposed_value)
    return more == floor_value and floor_value != proposed_value


def validate_semantic_action(
    raw: Mapping[str, Any],
    *,
    base_action: Action | None = None,
    platform_forbidden: Mapping[str, Any] | None = None,
    confidence_floor: float = 0.65,
) -> Action | None:
    """Validate one model-proposed action. Returns ``None`` (fail-closed,
    never an exception — including on a malformed, non-dict ``release``
    payload) on any schema violation, sub-floor confidence, or a
    consistency violation against ``base_action``/``platform_forbidden``.
    See the module docstring for the full contract, including the
    mandatory separate provenance check this function does NOT perform."""
    try:
        if not isinstance(raw, Mapping):
            raise ValueError("payload must be an object")
        unknown = set(raw.keys()) - _ALLOWED_TOP_LEVEL_KEYS
        if unknown:
            raise ValueError(f"payload has unknown field(s): {sorted(unknown)}")

        objective = raw["objective"]
        if objective not in _OBJECTIVE_VALUES:
            raise ValueError("unknown objective")

        target = raw["target"]
        if not isinstance(target, str) or not target.strip():
            raise ValueError("target must be a non-empty string")

        state = raw.get("state", "requested")
        if state not in _ACTION_STATE_VALUES:
            raise ValueError("unknown action state")

        prohibited_raw = raw.get("prohibited", ())
        if not isinstance(prohibited_raw, (list, tuple)) or any(p not in _OBJECTIVE_VALUES for p in prohibited_raw):
            raise ValueError("prohibited must be a list of known objectives")
        prohibited = tuple(dict.fromkeys(prohibited_raw))

        confidence = raw.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise ValueError("confidence must be a number")
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("confidence out of range")

        release = _validated_release(raw.get("release") or {})
    except Exception:  # noqa: BLE001 — deliberate fail-closed boundary, matches
        # student_intent._semantic_model_call's house style: ANY malformed
        # input (including a non-dict `release`, which would otherwise
        # raise an uncaught AttributeError) must degrade to None, never
        # propagate.
        return None

    if confidence < confidence_floor:
        return None

    for field in FIELD_NAMES:
        proposed = getattr(release, field)
        if base_action is not None and _violates_restrictiveness_floor(field, getattr(base_action.release, field), proposed):
            # The model may ADD a restriction but may never REMOVE/loosen
            # one already trusted at high confidence.
            return None
        if platform_forbidden and field in platform_forbidden and _violates_restrictiveness_floor(field, platform_forbidden[field], proposed):
            # Nor may it loosen past what a platform rule already forced.
            return None

    return Action(objective=objective, target=target, release=release, state=state, prohibited=prohibited)


__all__ = ["needs_semantic_escalation", "validate_semantic_action"]

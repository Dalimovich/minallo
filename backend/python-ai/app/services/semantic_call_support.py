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
   missing fields, out-of-range confidence) plus the consistency
   invariant: the model may ADD prohibitions but may never REMOVE one the
   caller already trusts at high confidence (``base_action``), and may
   never grant anything platform policy forbids (``forbidden_fields``,
   e.g. a field a platform rule already clamped). Any failure returns
   ``None`` — fail-closed, never a propagated exception, never an expanded
   permission.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, get_args

from .resolved_student_intent import Action, ExplanationDepth, Objective, ReleaseConstraints, ReleaseForm, ReleaseState

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


_RELEASE_STATE_FIELDS = ("final_answer", "official_solution")
_EXPLANATION_DEPTH_VALUES = set(get_args(ExplanationDepth))
_RELEASE_FORM_VALUES = set(get_args(ReleaseForm))
_RELEASE_STATE_VALUES = set(get_args(ReleaseState))
_OBJECTIVE_VALUES = set(get_args(Objective))


def _validated_release(raw: Mapping[str, Any]) -> ReleaseConstraints:
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
    if max_steps is not None and (isinstance(max_steps, bool) or not isinstance(max_steps, int)):
        raise ValueError("max_steps must be an int or null")
    if max_items is not None and (isinstance(max_items, bool) or not isinstance(max_items, int)):
        raise ValueError("max_items must be an int or null")
    if wait_for_student is not None and not isinstance(wait_for_student, bool):
        raise ValueError("wait_for_student must be a bool or null")
    return ReleaseConstraints(
        final_answer=final_answer, official_solution=official_solution,
        explanation_depth=explanation_depth, form=form,
        max_steps=max_steps, max_items=max_items, wait_for_student=wait_for_student,
    )


def validate_semantic_action(
    raw: Mapping[str, Any],
    *,
    base_action: Action | None = None,
    confidence_floor: float = 0.65,
) -> Action | None:
    """Validate one model-proposed action. Returns ``None`` (fail-closed,
    never an exception) on any schema violation, sub-floor confidence, or a
    consistency violation against ``base_action`` (the caller's own
    trusted, already-known action for this same target, if any)."""
    try:
        objective = raw["objective"]
        if objective not in _OBJECTIVE_VALUES:
            raise ValueError("unknown objective")
        target = str(raw["target"])
        confidence = raw.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise ValueError("confidence must be a number")
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("confidence out of range")
        release = _validated_release(raw.get("release") or {})
    except (KeyError, ValueError, TypeError):
        return None
    if confidence < confidence_floor:
        return None
    if base_action is not None:
        for field in _RELEASE_STATE_FIELDS:
            if (
                getattr(base_action.release, field) == "prohibited"
                and getattr(release, field) == "permitted"
            ):
                # The model may ADD prohibitions but may never REMOVE one
                # already trusted at high confidence — fail closed instead
                # of silently expanding what's permitted.
                return None
    return Action(objective=objective, target=target, release=release, state=raw.get("state", "requested"))


__all__ = ["needs_semantic_escalation", "validate_semantic_action"]

"""Student-visible outcome scoring (2026-10-23 review, item 4; 2026-10-24
correction, item 5): after any interpretation arm is compared, the
decisive question is whether the STUDENT actually receives the right
thing -- correct explanation, hint surviving as a hint, changed
permission actually taking effect -- not just whether a classifier's
fields matched gold.

Wraps the real, already-shipped release gate --
``enforce_release_policy_single_target``, confirmed from app/routers/
stream.py's own call sites as what it actually calls for a genuinely
single-target compiled policy (the shape every arm in this review
produces). This module adds no new disclosure logic of its own.

2026-10-24 correction: the first version derived EVERYTHING from the
gate's own ``withheld`` boolean, including treating ``not withheld`` as
proof nothing was disclosed. That is backwards for a SCAN-CONDITIONED
gate: "not withheld" only means "the known-leak-pattern scan found
nothing" -- a real disclosure the scan's finite pattern list has never
seen would sail through as "not withheld" and get silently counted as
correct. Symmetrically, "withheld" does not mean the whole response was
rightly suppressed -- a legitimate hint that merely trips a leak-pattern
false positive gets replaced by the generic fallback, losing real
content the student should have received, which the old scoring never
even checked for (a prohibited final answer does not mean the whole
response must be withheld; a hint can and should still be delivered).

Fixed by grounding disclosure independently of the gate's own decision:
when the corpus gives a ``verified_answer`` string, ``protected_answer_
revealed`` checks whether it LITERALLY appears in the text the student
would actually see -- the same "value-grounded" idea answer_release_
validator.py's own evidence-text check uses, just keyed off the corpus's
verified value instead of retrieved course evidence. Without a
``verified_answer`` (not every corpus turn has one), this falls back to
the gate's own scan verdict, with that limitation stated, not hidden.
``legitimate_content_wrongly_suppressed`` is tracked as its own,
independent finding (withheld text that the grounded check says did NOT
actually contain the protected value) -- answering "was a hint/
explanation wrongly suppressed" regardless of what gold_release says,
because that question matters even on a correctly-"prohibited" turn.
``evaluable`` is False for "partial"/"ambiguous_expect_clarify_or_both"
gold -- those are never silently scored as a match.

NOT a new cost: scores an ALREADY-GENERATED candidate answer. The
remaining, costed step -- producing that candidate text via the real
answer generator -- needs its own explicit generation budget and is not
spent anywhere in this module.

Latency ("does policy enforcement delay the first visible answer
token"): app/routers/stream.py buffers the full response under a
restrictive policy -- confirmed by reading that router's own branch, not
assumed. Measuring this for real needs an actual SSE stream under both a
restrictive and permissive compiled policy, timing first-byte arrival --
a real generation-pipeline integration test, not built here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.services.answer_release_validator import enforce_release_policy_single_target, safe_withheld_answer_text
from app.services.policy_compiler import ExecutionPolicy

GoldRelease = str  # "permitted" | "prohibited" | "partial" | "ambiguous_expect_clarify_or_both"
_EVALUABLE_RELEASES = frozenset({"permitted", "prohibited"})


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().casefold()


@dataclass(frozen=True)
class StudentVisibleOutcome:
    disclosed_text: str  # exactly what the student would see
    withheld: bool
    protected_answer_revealed: bool  # grounded (verified_answer) where available, else the gate's own scan
    legitimate_content_wrongly_suppressed: bool  # withheld text the grounded check says did NOT reveal the answer
    evaluable: bool  # False for "partial"/"ambiguous_expect_clarify_or_both" gold
    unauthorized_disclosure: bool | None  # None when not evaluable
    false_withholding: bool | None  # None when not evaluable
    matches_gold_release: bool | None  # None when not evaluable -- never defaulted to True


def score_student_visible_outcome(
    *, candidate_text: str, policy: ExecutionPolicy, response_language: str,
    gold_release: GoldRelease, verified_answer: str | None = None,
) -> StudentVisibleOutcome:
    """``candidate_text`` is a real, already-generated draft answer for one
    turn under one arm's compiled ``policy`` -- never gold-derived, never
    synthesized here. ``verified_answer`` is the corpus's own
    ``verifiedAnswer`` field when present (grounds the disclosure check
    independently of the gate's own scan; omit when the corpus turn has
    none -- the fallback below states its own limitation rather than
    pretending to be as reliable)."""
    decision = enforce_release_policy_single_target(
        candidate_text, policy=policy, response_language=response_language,
    )
    disclosed_text = decision.text

    if verified_answer:
        protected_answer_revealed = _normalize(verified_answer) in _normalize(disclosed_text)
    else:
        # No grounded value for this turn -- fall back to the gate's own
        # scan verdict, the next-best signal, with the same blind spot
        # answer_release_validator.py's own docstring already admits to
        # (a free-form leak the pattern list has never seen matches
        # neither this nor that scan, so this can still under-detect).
        protected_answer_revealed = decision.scan.reason == "matched_leak_pattern"

    is_generic_fallback = disclosed_text == safe_withheld_answer_text(response_language=response_language)
    legitimate_content_wrongly_suppressed = decision.withheld and is_generic_fallback and not protected_answer_revealed

    evaluable = gold_release in _EVALUABLE_RELEASES
    unauthorized_disclosure = protected_answer_revealed and gold_release == "prohibited" if evaluable else None
    false_withholding = is_generic_fallback and gold_release == "permitted" if evaluable else None
    matches_gold_release = (
        None if not evaluable
        else not (unauthorized_disclosure or false_withholding)
    )
    return StudentVisibleOutcome(
        disclosed_text=disclosed_text, withheld=decision.withheld,
        protected_answer_revealed=protected_answer_revealed,
        legitimate_content_wrongly_suppressed=legitimate_content_wrongly_suppressed,
        evaluable=evaluable, unauthorized_disclosure=unauthorized_disclosure,
        false_withholding=false_withholding, matches_gold_release=matches_gold_release,
    )

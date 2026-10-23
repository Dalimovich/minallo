"""Student-visible outcome scoring (2026-10-23 review, item 4): after any
interpretation arm is compared, the decisive question is whether the
STUDENT actually receives the right thing -- correct explanation, hint
surviving as a hint, changed permission actually taking effect -- not
just whether a classifier's fields matched gold.

Wraps the real, already-shipped release gate -- specifically
``enforce_release_policy_single_target``, confirmed by reading
app/routers/stream.py's own call sites (~line 6921) as what it actually
calls for a genuinely single-target compiled policy (the shape every arm
in this review produces; multi-target turns are already excluded
elsewhere in this review's scoring, see jev_policy_adapter.py). The
PLURAL ``enforce_release_policy_per_target`` is now a thin, deliberately
inert wrapper around the stricter, unconditional ``enforce_release_
policy`` -- its own docstring says the permissive per-target path was
disabled "after further review" -- so a multi-target policy and a
single-target policy go through genuinely different gates in production;
wrapping the wrong one here would have quietly modeled the wrong
behavior (an earlier draft of this module did exactly that, caught by its
own test against a hand-built policy before being trusted for anything).
This module adds no new disclosure logic of its own -- a bug fixed here
would be a bug fixed in test-only code, not in what students actually get.

NOT a new cost: scores an ALREADY-GENERATED candidate answer against a
compiled ExecutionPolicy and the corpus's gold expectation. The remaining,
costed step -- producing that candidate text at all, once per (turn,
candidate interpretation arm) via the real answer generator -- needs its
own explicit generation budget (priced differently from a classifier
call: a full answer, not a short JSON classification) and is not spent
anywhere in this module.

Latency ("does policy enforcement delay the first visible answer token",
also asked for in item 4): app/routers/stream.py buffers the full response
before release specifically when a restrictive policy is active (full-
response buffering, rather than true token streaming) -- confirmed by
reading that router's own policy-release branch, not assumed. Measuring
this for real needs an actual SSE stream under both a restrictive and a
permissive compiled policy for the SAME question, timing first-byte
arrival -- a real generation-pipeline integration test, not a pure
function like score_student_visible_outcome below, and not built here.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.services.answer_release_validator import enforce_release_policy_single_target
from app.services.policy_compiler import ExecutionPolicy

GoldRelease = str  # "permitted" | "prohibited" | "partial" | "ambiguous_expect_clarify_or_both"


@dataclass(frozen=True)
class StudentVisibleOutcome:
    withheld: bool
    disclosed_text: str  # exactly what the student would see: the safe-withheld text, or candidate_text verbatim
    matches_gold_release: bool
    false_withholding: bool  # withheld, but gold says this should have been permitted
    unauthorized_disclosure: bool  # not withheld, but gold says this should have been prohibited


def score_student_visible_outcome(
    *, candidate_text: str, policy: ExecutionPolicy, response_language: str, gold_release: GoldRelease,
) -> StudentVisibleOutcome:
    """``candidate_text`` is a real, already-generated draft answer for one
    turn under one arm's compiled ``policy`` -- never gold-derived, never
    synthesized by this module. ``gold_release`` is the corpus's own
    expected release level for this turn (its scoring meaning, NOT an
    input to the decision -- the decision above already happened inside
    ``enforce_release_policy`` using only ``policy``)."""
    decision = enforce_release_policy_single_target(candidate_text, policy=policy, response_language=response_language)
    gold_wants_permitted = gold_release == "permitted"
    gold_wants_prohibited = gold_release == "prohibited"
    # "partial"/"ambiguous_expect_clarify_or_both" have no single right
    # withheld/disclosed answer at this granularity -- never scored as a
    # match OR a miss here; a real per-case review is needed for those,
    # same as the other harnesses in this review already treat them.
    matches_gold_release = (
        (decision.withheld and gold_wants_prohibited)
        or (not decision.withheld and gold_wants_permitted)
        or gold_release in ("partial", "ambiguous_expect_clarify_or_both")
    )
    return StudentVisibleOutcome(
        withheld=decision.withheld,
        disclosed_text=decision.text,
        matches_gold_release=matches_gold_release,
        false_withholding=decision.withheld and gold_wants_permitted,
        unauthorized_disclosure=(not decision.withheld) and gold_wants_prohibited,
    )

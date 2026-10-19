"""Milestone 2 — concurrent-gather primitive for the two classification call
sites, per the Milestone 1 decision.

Call #1 (``dialogue_state.resolve_dialogue_semantically``) and call #2 (the
semantic escalation inside ``student_intent.interpret_student_intent``) are
NOT merged into one model call — call #2's prompt includes call #1's
*resolved* dialogue (``dialogue.resolved_request`` / ``dialogue.active_
question``, see ``student_intent.py``'s ``frame`` dict) as an input, so a
single merged call would lose the "deterministic reference resolution feeds
the semantic layer" boundary.

What CAN change: today ``app/routers/stream.py`` runs them as two
sequential ``await run_in_threadpool(...)`` calls. Milestone 1's
recommendation is to run them concurrently via ``asyncio.gather`` instead.
Because of the data dependency above, "concurrently" here specifically
means: call #2 is started against the DETERMINISTIC (pre-semantic) dialogue
resolution — the same ``base`` that already feeds ``_needs_semantic_path``
— at the same moment call #1 starts upgrading that resolution semantically,
rather than waiting for call #1 to finish first. That is a real (small)
accuracy trade-off: call #2 may see a slightly less-resolved
``resolved_request``/``active_question`` than it would after a sequential
await. It is the trade-off Milestone 1 flagged as acceptable because call
#2 mainly reasons about prohibitions/negation/multi-target structure, not
about WHAT the deictic reference resolves to. Each call keeps its own
independent fail-closed contract — a failure in one must never affect the
other's result, which is what ``gather_independent`` below guarantees.

NOT wired into ``app/routers/stream.py`` in this milestone — that file is
an explicitly out-of-scope consumer here (Milestone 2 is "isolated
foundations"; the actual call-site change is Milestone 3). This module
exists so the concurrency + failure-isolation mechanism can be proven with
mocked tests ahead of that wiring landing.

Hardening-pass addendum (code review, not yet resolved — a real open
product decision, not a code bug):

A passing ``asyncio.gather`` test proves the TWO CALLS don't corrupt each
other's results. It does NOT prove the concurrent path's classification is
SEMANTICALLY EQUIVALENT to the sequential path's — see
``test_concurrent_classification.py::
test_concurrent_path_produces_a_measurably_less_resolved_student_goal``
for a concrete, reproduced case where it is not: "go ahead" after an
assistant turn offering to extend a flashcard set to a new topic resolves,
sequentially, to a goal mentioning that topic and classifies as
``FLASHCARD_GENERATION``; run concurrently against the deterministic
``base`` instead, it stays the literal "go ahead" and classifies as the
generic ``GENERAL_COURSE_QA``. That is a real accuracy cost, not a
theoretical one.

Four shapes this could legitimately take, per the Milestone 1 report
(``docs/semantic-intent-milestone-1-report.md``, §8/S12.6):

1. One combined structured semantic call (both classifications from one
   prompt) — explicitly rejected by Milestone 1: call #2's prompt needs
   call #1's resolved output as an input, so merging loses that boundary.
2. Two dependent sequential calls (today's deployed behavior) — correct,
   but pays both calls' latency serially every time either gate fires.
3. A deterministic dialogue stage (no model call) followed by ONE
   semantic call covering what's left — would need call #2's own prompt
   broadened to also resolve what call #1 currently resolves semantically,
   collapsing two triggers into one call. Not designed or evaluated here.
4. Two concurrent calls with an explicitly accepted accuracy trade-off —
   what THIS module implements.

Milestone 1's own S12.6 line item is "model budget — ≤1 classification
call/turn, don't assume merge", and its answer was "run both concurrently,
don't merge" — which satisfies "don't assume merge" but does NOT satisfy
"≤1 classification call/turn" on any reading where call #1 and call #2
both count against that budget: concurrency changes LATENCY, not CALL
COUNT. Whether that budget line was meant to cap TOTAL classification
calls (in which case today's sequential dual-call behavior already
exceeds it, independent of anything in this module) or only the NEW
call #2 beyond an already-accepted call #1, is not resolved anywhere in
this repository that this hardening pass could find. This module does not
resolve it either — it only proves option 4 is mechanically safe
(failure-isolated) IF option 4 is the one chosen. That choice, and the
budget-counting question, need an explicit product decision before any
Milestone 3 wiring, not just a passing test.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class ConcurrentCallResult:
    """One gathered call's outcome. ``error`` is set only for a failure
    mode the call itself did NOT already catch — both real call sites
    (``resolve_dialogue_semantically`` and ``interpret_student_intent``)
    already fail closed internally (each has its own ``try/except`` around
    the model call, degrading to a safe fallback object rather than
    raising). This field exists purely as a second, defensive layer so an
    unexpected bug outside either function's own boundary still can't take
    the OTHER call's already-computed result down with it."""

    value: Any
    error: BaseException | None


async def gather_independent(*calls: Callable[[], Any]) -> tuple[ConcurrentCallResult, ...]:
    """Run each zero-arg ``calls`` entry concurrently (each off the event
    loop, via ``asyncio.to_thread`` — these are blocking calls, same reason
    ``stream.py`` uses ``run_in_threadpool`` for them today) and isolate
    failures: one raising never prevents the others' results from coming
    back. Order of the returned tuple matches the order of ``calls``."""
    raw = await asyncio.gather(
        *(asyncio.to_thread(call) for call in calls), return_exceptions=True,
    )
    return tuple(
        ConcurrentCallResult(value=None, error=item) if isinstance(item, BaseException)
        else ConcurrentCallResult(value=item, error=None)
        for item in raw
    )


async def resolve_dialogue_and_intent_concurrently(
    *, dialogue_call: Callable[[], Any], intent_call: Callable[[], Any],
) -> tuple[ConcurrentCallResult, ConcurrentCallResult]:
    """The two-call-site-specific wrapper: ``dialogue_call`` is a closure
    over ``resolve_dialogue_semantically(...)``, ``intent_call`` a closure
    over ``interpret_student_intent(...)`` built against the deterministic
    ``base`` dialogue resolution (see module docstring for why). Returns
    both results; the caller applies whatever "if error, use base/off"
    fallback it already has — this function does not invent a new one."""
    dialogue_result, intent_result = await gather_independent(dialogue_call, intent_call)
    return dialogue_result, intent_result


__all__ = ["ConcurrentCallResult", "gather_independent", "resolve_dialogue_and_intent_concurrently"]

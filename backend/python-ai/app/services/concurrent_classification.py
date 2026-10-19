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

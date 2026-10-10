"""Process-wide concurrency bounds for outbound generation LLM work.

The structured-generation paths (quiz, flashcards, cheatsheet, examforge,
notes, study-planner, topic extraction, …) all fan out through
``llm_json.chat_json``, several of them via per-request ``ThreadPoolExecutor``
pools (cheatsheet alone spawns up to 10 shard threads). Those threads live
OUTSIDE the anyio threadpool limiter, so a burst of concurrent generations can
spawn effectively unbounded threads — saturating the single OpenAI key's
TPM/RPM budget and the 2 GB box's memory, and starving everything else.

A single process-wide ``BoundedSemaphore`` caps how many generation LLM calls
run at once, turning unbounded fan-out into backpressure (extra shards simply
wait for a slot). The interactive ask/stream answer path does NOT go through
``chat_json``, so it is never throttled by this bound — bulk generation can't
starve live tutoring.

Sized by ``LLM_FANOUT_MAX_CONCURRENCY`` (per worker process; default 16).
"""

from __future__ import annotations

import contextlib
import os
import threading

_DEFAULT_FANOUT = 16


def _fanout_limit() -> int:
    try:
        return max(1, int(os.environ.get("LLM_FANOUT_MAX_CONCURRENCY", "")))
    except ValueError:
        return _DEFAULT_FANOUT


_FANOUT_LIMIT = _fanout_limit()
_fanout_sem = threading.BoundedSemaphore(_FANOUT_LIMIT)


@contextlib.contextmanager
def llm_fanout_slot():
    """Block until a generation LLM slot is free, then hold it for the call."""
    _fanout_sem.acquire()
    try:
        yield
    finally:
        _fanout_sem.release()


def fanout_stats() -> dict[str, int]:
    """Best-effort snapshot for /metrics: total slots and how many are held."""
    # BoundedSemaphore keeps its remaining count in the private ``_value``.
    remaining = getattr(_fanout_sem, "_value", _FANOUT_LIMIT)
    in_use = max(0, _FANOUT_LIMIT - remaining)
    return {"limit": _FANOUT_LIMIT, "in_use": in_use}

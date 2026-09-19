"""Per-request generation timing for the German generators.

Answers "where do the 60-120 seconds go?" without guessing: every
``chat_json`` call made while a request is being timed records its caller
module, model, reasoning effort, how long it waited for a fanout slot
(``slotWaitMs``) and how long the provider took (``providerMs``). The endpoint
attaches a safe summary to the response (``diagnostics``) and logs one
structured line. No prompts, completions, tokens or user content are recorded.

The timer travels in a ContextVar; ``ContextThreadPoolExecutor`` carries it
into worker threads (plain ThreadPoolExecutor does not copy context).
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .concurrency import fanout_stats

log = logging.getLogger("minallo.gen_timing")

_current: contextvars.ContextVar["GenTimer | None"] = contextvars.ContextVar("gen_timer", default=None)


class GenerationBudgetExceeded(Exception):
    """The request's wall-clock budget is spent; further LLM work is pointless."""


# Below the edge function's upstream timeout (105s) and Cloudflare's ~120s
# edge limit: once the caller can no longer receive a result, stop spending
# LLM calls and fanout slots on it (abandoned generations otherwise keep
# running and starve every other generator on the worker).
DEFAULT_BUDGET_S = float(os.getenv("GERMAN_GEN_BUDGET_S", "95") or 95)


class GenTimer:
    def __init__(self, module: str, part: str | None = None, request_id: str | None = None,
                 budget_s: float | None = None):
        self.budget_s = budget_s if budget_s is not None else DEFAULT_BUDGET_S
        self.request_id = request_id or uuid.uuid4().hex[:12]
        self.module = module
        self.part = part
        self.started = time.perf_counter()
        self.fanout_at_start = fanout_stats()
        self._lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []
        self.stages: dict[str, float] = {}

    def remaining_s(self) -> float:
        return self.budget_s - (time.perf_counter() - self.started)

    def expired(self) -> bool:
        return self.remaining_s() <= 0

    def record_call(self, *, caller: str, model: str, effort: str | None, slot_wait_ms: float,
                    provider_ms: float, ok: bool) -> None:
        with self._lock:
            self.calls.append({
                "caller": caller, "model": model, "effort": effort,
                "slotWaitMs": round(slot_wait_ms), "providerMs": round(provider_ms), "ok": ok,
            })

    def add_stage(self, name: str, ms: float) -> None:
        with self._lock:
            self.stages[name] = self.stages.get(name, 0.0) + ms

    def summary(self, outcome: str) -> dict[str, Any]:
        total_ms = round((time.perf_counter() - self.started) * 1000)
        by_caller: dict[str, dict[str, int]] = {}
        with self._lock:
            calls = list(self.calls)
            stages = {k: round(v) for k, v in self.stages.items()}
        for c in calls:
            agg = by_caller.setdefault(c["caller"], {"calls": 0, "providerMs": 0, "slotWaitMs": 0})
            agg["calls"] += 1
            agg["providerMs"] += c["providerMs"]
            agg["slotWaitMs"] += c["slotWaitMs"]
        return {
            "requestId": self.request_id,
            "module": self.module,
            "partId": self.part,
            "outcome": outcome,
            "totalMs": total_ms,
            "budgetS": self.budget_s,
            "llmCalls": len(calls),
            "providerMsSum": sum(c["providerMs"] for c in calls),
            "slotWaitMsSum": sum(c["slotWaitMs"] for c in calls),
            "longestCallMs": max((c["providerMs"] for c in calls), default=0),
            "byCaller": by_caller,
            "models": sorted({f"{c['model']}:{c['effort'] or 'default'}" for c in calls}),
            "stagesMs": stages,
            "fanoutAtStart": self.fanout_at_start,
            "backendRevision": os.getenv("MINALLO_REVISION", "unknown"),
        }


def current() -> GenTimer | None:
    return _current.get()


@contextlib.contextmanager
def timed_request(module: str, part: str | None = None, budget_s: float | None = None):
    """Time one generation request; yields the timer. Call ``finish`` to emit."""
    timer = GenTimer(module, part, budget_s=budget_s)
    token = _current.set(timer)
    try:
        yield timer
    finally:
        _current.reset(token)


def finish(timer: GenTimer, outcome: str) -> dict[str, Any]:
    summary = timer.summary(outcome)
    log.info("gen_timing %s", json.dumps(summary, separators=(",", ":")))
    return summary


@contextlib.contextmanager
def stage(name: str):
    timer = _current.get()
    t0 = time.perf_counter()
    try:
        yield
    finally:
        if timer is not None:
            timer.add_stage(name, (time.perf_counter() - t0) * 1000)


class ContextThreadPoolExecutor(ThreadPoolExecutor):
    """ThreadPoolExecutor whose tasks run in the submitter's context."""

    def submit(self, fn, /, *args, **kwargs):  # type: ignore[override]
        ctx = contextvars.copy_context()
        return super().submit(ctx.run, fn, *args, **kwargs)

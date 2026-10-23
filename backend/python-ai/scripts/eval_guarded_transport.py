"""Generalized version of run_student_intent_eval.py's ``GuardedTransport``
(2026-10-17) -- same durability/safety contract, provider-agnostic.

Why generalized rather than copied: Phase 3 of the 2026-10-23 Jev review
asked for "one durable record per attempted request: evaluation arm,
scenario, requested and returned model, token counts, estimated charge,
latency, retries, errors, and cumulative cost" for BOTH the OpenAI-backed
arms (A: legacy escalation, B: Milestone 4) and any future Jev-backed arm
(C/D) -- one ledger implementation, not three copies that could silently
drift on what counts as a reservation.

Contract, unchanged from the original: every HTTP attempt (including SDK
retries) is validated and durably reserved BEFORE it is sent -- fsync'd to
the ledger file, never refunded even on error -- so a crash mid-run leaves
an accurate record of what was actually risked, not just what succeeded. An
existing ledger file refuses a second run outright (``touch(exist_ok=False)``):
no silent reruns/overwrites of a prior attempt's cost record.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable

import httpx


class BudgetStop(BaseException):
    """Must bypass SDK retries AND production's own Exception-fallback
    boundary -- a real provider call site is allowed to catch broad
    ``Exception`` and degrade gracefully; a budget stop must never be
    mistaken for that and silently swallowed."""


class EvalGuardedTransport(httpx.BaseTransport):
    """``validate_and_price(body) -> (reserved_usd, requested_model)``
    raises ``BudgetStop`` itself for an unapproved endpoint/model/shape --
    kept as the caller's own callback (not hardcoded here) so OpenAI's
    JSON-mode classifier shape and Jev's systemone shape can each be
    validated by code that actually understands that provider's contract,
    without this shared class guessing at it.

    Set ``.context`` (a dict) before each call this transport will carry --
    e.g. ``{"arm": "A", "scenario": "AB-01", "turn": 1}`` -- so every ledger
    line is attributable to the specific eval case that triggered it."""

    def __init__(
        self, ledger_path: Path, inner: httpx.BaseTransport, url: str,
        validate_and_price: Callable[[dict], tuple[float, str]],
        *, max_requests: int, budget_usd: float,
    ):
        if not 0 < max_requests <= 200 or not 0 < budget_usd <= 10:
            raise ValueError("limits must be positive and within 200 requests / $10")
        self.ledger_path = Path(ledger_path)
        self.ledger_path.touch(exist_ok=False)
        self.inner = inner
        self.url = url
        self.validate_and_price = validate_and_price
        self.max_requests = max_requests
        self.budget_usd = budget_usd
        self.attempts: list[dict] = []
        self.context: dict = {}

    @property
    def spent_usd(self) -> float:
        return sum(a["reserved_usd"] for a in self.attempts)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) != self.url or request.method != "POST":
            raise BudgetStop(f"unapproved endpoint: {request.method} {request.url}")
        body = json.loads(request.content)
        reserved_usd, requested_model = self.validate_and_price(body)  # raises BudgetStop itself if invalid
        if len(self.attempts) >= self.max_requests:
            raise BudgetStop(f"request-count ceiling reached ({self.max_requests})")
        if self.spent_usd + reserved_usd > self.budget_usd:
            raise BudgetStop(f"cost ceiling reached (${self.spent_usd:.4f} + ${reserved_usd:.6f} > ${self.budget_usd:.2f})")
        attempt = {
            **self.context, "attempt_number": len(self.attempts) + 1,
            "requested_model": requested_model, "reserved_usd": reserved_usd,
            "sdk_retry": int(request.headers.get("x-stainless-retry-count", "0")),
        }
        with self.ledger_path.open("a", encoding="utf-8") as out:
            out.write(json.dumps(attempt) + "\n")
            out.flush()
            os.fsync(out.fileno())
        self.attempts.append(attempt)
        started = time.perf_counter()
        try:
            response = self.inner.handle_request(request)
            response.read()
            attempt["status"] = response.status_code
            if response.status_code == 200:
                data = response.json()
                attempt["returned_model"] = data.get("model")
                attempt["usage"] = data.get("usage")
            return response
        except Exception as exc:
            attempt["error"] = type(exc).__name__  # never log request body/headers/credentials
            raise
        finally:
            attempt["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)

    def close(self) -> None:
        self.inner.close()

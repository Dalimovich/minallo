"""Bounded-cost live-QA harness support, shared by every German Exam QA script.

Every live QA script for German Exam content (TELC/Goethe today, TestDaF once
credits are restored) must go through this module rather than call a provider
without a budget: it enforces a hard sample cap and a hard USD cost cap BEFORE
each new sample's paid call — not only after the fact — refuses to run at all
without both bounds explicitly given, and caps them at safe defaults (at most
1 sample, at most $0.25). It also overrides the usage-meter feature label for
the duration of a run, so a QA script's LLM calls are never misattributed to
``__main__`` or to whichever generator module they happen to call through.

This module makes zero provider calls itself and imports nothing that does at
module load time — it is pure bookkeeping, safe to unit test with fakes.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

# Hard ceilings this harness will never let a caller raise past, regardless of
# what a script's own CLI defaults or the operator passes.
SAFE_MAX_COST_USD = 0.25
SAFE_MAX_SAMPLES = 1


class BudgetExceeded(RuntimeError):
    """Raised by `QaBudget.guard_new_sample()` to terminate a run before the
    next paid call — the caller must stop, not merely log and continue."""


@dataclass
class QaBudget:
    """Tracks spend/sample counts for one QA run and refuses to exceed either
    bound. `label` is the usage-meter feature label this run must be
    attributed under (see `labeled_usage`)."""

    max_cost_usd: float
    max_samples: int
    label: str
    spent_usd: float = 0.0
    samples_run: int = 0
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.label or not self.label.strip():
            raise ValueError("QaBudget requires an explicit non-empty usage label")
        if self.max_cost_usd is None or self.max_cost_usd <= 0:
            raise ValueError("--max-cost-usd must be a positive number; unbounded QA runs are refused")
        if self.max_cost_usd > SAFE_MAX_COST_USD:
            raise ValueError(f"--max-cost-usd may not exceed the safe default of ${SAFE_MAX_COST_USD:.2f}")
        if self.max_samples is None or self.max_samples <= 0:
            raise ValueError("--max-samples must be a positive integer; unbounded QA runs are refused")
        if self.max_samples > SAFE_MAX_SAMPLES:
            raise ValueError(f"--max-samples may not exceed the safe default of {SAFE_MAX_SAMPLES}")

    def guard_new_sample(self) -> None:
        """Call immediately before starting a new sample's generation — i.e.
        before the next paid provider call is made. Raises `BudgetExceeded`
        (the caller must stop the run) once either bound is already spent, so
        the budget is enforced going into a call, never discovered only by
        totalling cost afterward."""
        if self.samples_run >= self.max_samples:
            raise BudgetExceeded(f"sample budget exhausted ({self.samples_run}/{self.max_samples})")
        if self.spent_usd >= self.max_cost_usd:
            raise BudgetExceeded(f"cost budget exhausted (${self.spent_usd:.4f}/${self.max_cost_usd:.2f})")

    def record_call(self, cost_usd: float | None, **details: Any) -> None:
        """Call once per completed sample with its actual (estimated) cost.
        A None/unpriced cost is treated as 0 for the running total — never as
        a licence to keep going past a cap that can't be verified; scripts
        should still prefer priced models for QA runs."""
        self.spent_usd += max(0.0, cost_usd or 0.0)
        self.calls.append({"costUsd": cost_usd, **details})

    def record_sample(self) -> None:
        self.samples_run += 1


def add_budget_args(parser: argparse.ArgumentParser) -> None:
    """Adds --max-cost-usd/--max-samples as REQUIRED arguments with no
    default — an operator must explicitly choose bounded values every run."""
    parser.add_argument(
        "--max-cost-usd", type=float, required=True,
        help=f"Hard cost ceiling in USD for this run; must be > 0 and <= {SAFE_MAX_COST_USD:.2f}. "
             "No default is provided: an unbounded run is refused.",
    )
    parser.add_argument(
        "--max-samples", type=int, required=True,
        help=f"Hard sample-count ceiling for this run; must be > 0 and <= {SAFE_MAX_SAMPLES}. "
             "No default is provided: an unbounded run is refused.",
    )


@contextmanager
def labeled_usage(label: str) -> Iterator[None]:
    """Overrides `app.services.llm_json.record_usage`'s feature label for the
    duration of the block, so every usage_events row written by calls made
    inside it is attributed to `label` — never `__main__`, never the
    generator module's own name (llm_json's default `_caller_feature()`
    behaviour), so a live QA run is always distinguishable from ordinary
    generation traffic and from a stray ad-hoc script run."""
    from app.services import llm_json

    original = llm_json.record_usage

    def relabeled(**kwargs: Any) -> None:
        kwargs["feature"] = label
        return original(**kwargs)

    llm_json.record_usage = relabeled  # type: ignore[assignment]
    try:
        yield
    finally:
        llm_json.record_usage = original  # type: ignore[assignment]

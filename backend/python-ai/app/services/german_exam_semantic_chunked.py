"""Chunked orchestration of the EXISTING semantic verifier (Sprachbausteine).

Why: the single 22-gap verification call asks the reasoning model for 88
optionVerdicts under one completion budget (6000 + 22*400 = 14,800 tokens).
In production the hidden reasoning consumed the ENTIRE budget (exactly
14,800 reasoning tokens, twice), leaving no JSON: VERIFIER_RESPONSE_INVALID.

This module changes only the TRANSPORT: the 22 items are verified as three
concurrent chunks (8/7/7) by calling the unchanged ``verify_semantic`` once per
chunk, then the per-chunk results are merged back, in the original item order,
into one ``SemanticVerificationResult`` that the downstream code consumes
exactly as it consumed the single-call result. Semantic rules, prompt wording,
schema, model, reasoning effort and acceptance criteria are untouched.

Budgets: every verifier call (primary chunk or fallback half) gets the same fixed
cap, SPRACHBAUSTEINE_VERIFIER_CHUNK_MAX_TOKENS. Measured reasoning use does not scale
with chunk size (a 7-item chunk needed 3,000-4,700+ tokens, even 3-4 items exhausted
2,000-2,700), so a proportional split of the old single-call ceiling made valid calls
end before emitting JSON. Every call shares the request's existing deadline
(gen_timing timer); no second clock is created.

Fallback: ONLY a STRUCTURAL failure (no usable JSON / schema / id mismatch) of a
chunk triggers a single split of that chunk (8 -> 4+4, 7 -> 4+3), with the
same fixed cap for each half. A legitimate semantic rejection is a
successful verifier call and is never retried here. Depth is one; a failing
half fails the verification (no partial success).
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import Future, wait
from typing import Any, Callable

from . import gen_timing
from .german_exams import PartBlueprint
from .german_exam_semantic_verify import ItemSemanticResult, SemanticIssue, SemanticVerificationResult

log = logging.getLogger(__name__)

_PRIMARY_CHUNKS = 3
# Below this many items a single call is already comfortably inside its budget.
_MIN_ITEMS_TO_CHUNK = 10
_STAGE = "semantic_verify_chunk"

VerifyFn = Callable[..., SemanticVerificationResult]


# Per-call cap for the chunked Sprachbausteine verifier (primary AND fallback calls).
SPRACHBAUSTEINE_VERIFIER_CHUNK_MAX_TOKENS = 8000


def split_sizes(n: int, parts: int) -> list[int]:
    """Deterministic, order-preserving balanced sizes: 22/3 -> [8, 7, 7]."""
    base, extra = divmod(n, parts)
    return [base + (1 if i < extra else 0) for i in range(parts)]


def _structural_failure_reason(result: SemanticVerificationResult, expected_ids: list[str]) -> str | None:
    """Content-free reason when the verifier did not return usable structured
    output for exactly these items; None for a usable result (including one that
    contains legitimate semantic rejections)."""
    if any(i.code == "VERIFIER_RESPONSE_INVALID" for i in result.part_wide_issues):
        return "response_invalid"
    ids = [item.item_id for item in result.items]
    if len(ids) != len(set(ids)):
        return "duplicate_gap_id"
    if set(ids) != set(expected_ids):
        return "gap_id_mismatch"
    if any(i.code == "VERIFIER_RESPONSE_INVALID" for item in result.items for i in item.issues):
        return "item_response_invalid"
    return None


class _Run:
    def __init__(self, part: PartBlueprint, content: dict[str, Any], verify_fn: VerifyFn):
        self.part = part
        self.content = content
        self.verify_fn = verify_fn
        self.timer = gen_timing.current()

    def call(self, questions: list[dict[str, Any]], cap: int, label: dict[str, Any]) -> tuple[SemanticVerificationResult, str | None]:
        """One existing-verifier call over a subset of the questions."""
        ids = [q["questionId"] for q in questions]
        started = time.perf_counter()
        result = self.verify_fn(self.part, {**self.content, "questions": questions}, max_tokens=cap)
        reason = _structural_failure_reason(result, ids)
        usage = getattr(result, "usage", None) or {}
        entry = {
            "stage": _STAGE, **label, "chunkSize": len(ids), "gapIds": ids, "configuredTokenCap": cap,
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "status": "ok" if reason is None else "structural_failure",
            "structuralFailureReason": reason,
            "completionTokens": usage.get("completionTokens"), "reasoningTokens": usage.get("reasoningTokens"),
        }
        log.info("semantic_verify_chunk %s", entry)
        if self.timer is not None:
            self.timer.add_validation(entry)
        return result, reason

    def remaining(self) -> float | None:
        return self.timer.remaining_s() if self.timer is not None else None


def _wait_all(run: _Run, futures: list[Future]) -> None:
    """Wait for every future within the request's EXISTING deadline. On expiry the
    unfinished ones are cancelled and the request's normal budget error is raised
    (provider calls are themselves bounded by the same timer in chat_json)."""
    remaining = run.remaining()
    done, not_done = wait(futures, timeout=None if remaining is None else max(0.0, remaining))
    if not_done:
        for f in not_done:
            f.cancel()
        raise gen_timing.GenerationBudgetExceeded("generation time budget exhausted during semantic verification")


def _merge(original_ids: list[str], results: list[SemanticVerificationResult]) -> SemanticVerificationResult:
    by_id: dict[str, ItemSemanticResult] = {}
    part_wide: list[SemanticIssue] = []
    seen_issue: set[tuple[str, str, str]] = set()
    for res in results:
        for item in res.items:
            by_id[item.item_id] = item
        for issue in res.part_wide_issues:
            key = (issue.code, issue.severity, issue.message)
            if key not in seen_issue:  # one part-wide finding is one finding, not one per chunk
                seen_issue.add(key)
                part_wide.append(issue)
    assert set(by_id) == set(original_ids) and len(by_id) == len(original_ids), "aggregation lost or duplicated a gap"
    items = [by_id[i] for i in original_ids]  # original order, never completion order
    passed = not any(i.severity == "error" for i in part_wide) and all(item.passed for item in items)
    usage_keys = ("completionTokens", "reasoningTokens")
    usage = {k: sum(int((getattr(r, "usage", None) or {}).get(k) or 0) for r in results) for k in usage_keys}
    return SemanticVerificationResult(passed=passed, part_wide_issues=part_wide, items=items, usage=usage)


def _failure(message: str) -> SemanticVerificationResult:
    """Terminal structural verifier failure: this wrapper has already used its one
    bounded fallback, so the caller must not re-run the whole verification."""
    return SemanticVerificationResult(
        False, [SemanticIssue("VERIFIER_RESPONSE_INVALID", "error", message)], terminal_verifier_failure=True)


def verify_semantic_chunked(part: PartBlueprint, content: dict[str, Any], verify_fn: VerifyFn) -> SemanticVerificationResult:
    """Drop-in replacement for ``verify_fn(part, content)`` on a many-item part."""
    questions = list(content.get("questions") or [])
    n = len(questions)
    if n < _MIN_ITEMS_TO_CHUNK:
        return verify_fn(part, content)

    from .gen_timing import ContextThreadPoolExecutor  # noqa: WPS433

    original_ids = [q["questionId"] for q in questions]
    sizes = split_sizes(n, _PRIMARY_CHUNKS)
    cap = SPRACHBAUSTEINE_VERIFIER_CHUNK_MAX_TOKENS
    run = _Run(part, content, verify_fn)

    chunks: list[list[dict[str, Any]]] = []
    start = 0
    for size in sizes:
        chunks.append(questions[start:start + size])
        start += size

    pool = ContextThreadPoolExecutor(max_workers=2 * _PRIMARY_CHUNKS)
    try:
        primary = [
            pool.submit(run.call, chunk, cap, {"chunkIndex": i, "fallback": False})
            for i, chunk in enumerate(chunks)
        ]
        _wait_all(run, primary)

        outcomes: list[list[SemanticVerificationResult]] = [[] for _ in chunks]
        failed: list[int] = []
        for i, fut in enumerate(primary):
            try:
                result, reason = fut.result()
            except gen_timing.GenerationBudgetExceeded:
                raise
            except Exception:  # noqa: BLE001
                log.exception("semantic verifier chunk %s raised", i)
                result, reason = _failure("semantic verifier chunk raised"), "call_raised"
            if reason is None:
                outcomes[i] = [result]
            else:
                failed.append(i)

        # ONE bounded fallback: split only the structurally failed chunk(s); the
        # successful chunks are never re-run.
        fallback: dict[int, list[Future]] = {}
        fallback_questions: dict[int, list[list[dict[str, Any]]]] = {}
        for i in failed:
            chunk = chunks[i]
            if len(chunk) < 2:
                return _failure("semantic verifier could not return usable output for some items")
            if run.timer is not None and run.timer.remaining_s() <= 1:
                raise gen_timing.GenerationBudgetExceeded("generation time budget exhausted before verifier fallback")
            half = (len(chunk) + 1) // 2
            parts = [chunk[:half], chunk[half:]]
            fallback_questions[i] = parts
            fallback[i] = [
                pool.submit(run.call, part_q, cap, {"chunkIndex": i, "fallback": True, "subchunkIndex": j, "parentChunkIndex": i})
                for j, part_q in enumerate(parts)
            ]
        if fallback:
            _wait_all(run, [f for futs in fallback.values() for f in futs])
        for i, futs in fallback.items():
            for fut in futs:
                try:
                    result, reason = fut.result()
                except gen_timing.GenerationBudgetExceeded:
                    raise
                except Exception:  # noqa: BLE001
                    log.exception("semantic verifier fallback raised for chunk %s", i)
                    return _failure("semantic verifier fallback raised")
                if reason is not None:
                    # Depth is one: a failing half fails verification; nothing partial is returned.
                    return _failure("semantic verifier could not return usable output for some items")
                outcomes[i].append(result)
        return _merge(original_ids, [r for group in outcomes for r in group])
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

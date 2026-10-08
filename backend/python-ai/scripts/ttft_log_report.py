"""Before/after TTFT report from the production ask-stream logs.

Usage (from the server, or paste the output into a local file):

    docker compose logs --since 24h -t api \\
      | grep -E "ai_stream_timing|ai_execution_ttft|ai_execution_latency|ai_execution_complete|dialogue_semantic_classifier_fallback|future_not_ready_by_done" \\
      > /tmp/ttft.log

    python scripts/ttft_log_report.py /tmp/ttft.log
    # or: cat /tmp/ttft.log | python scripts/ttft_log_report.py

The -t flag matters: without it, docker doesn't prefix lines with a
timestamp, so the per-hour classifier-fallback breakdown below silently
drops to a total-only count instead of failing noisily.

Prints:
  - p50/p90 of ttft_ms (time to first answer text), overall and per
    execution_lane
  - p50/p90 of first_sse_ms and retrieval_ms
  - the share of requests where ttft_ms is within 10% of total_ms — i.e.
    the answer was effectively held back until it was fully done
  - how often dialogue_semantic_classifier_fallback fires (the classifier
    only logs on its failure path, not on every call, so this is reported
    as a count against total requests seen, not a true "% of follow-ups" —
    there's no log line marking every classifier attempt to use as that
    denominator)
  - how often *_future_not_ready_by_done fires (a decoration — visual aids
    or the Deep Learn recommendation — dropped because it wasn't ready by
    the time the answer finished)
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict

_TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})")
_FIRST_SSE_RE = re.compile(r"ai_stream_timing request_id=(\S+) phase=first_sse .*?first_sse_ms=([\d.]+)")
_RETRIEVAL_RE = re.compile(r"ai_stream_timing request_id=(\S+) phase=retrieval retrieval_ms=([\d.]+)")
_TTFT_RE = re.compile(r"ai_execution_ttft request_id=(\S+) execution_lane=(\S+) .*?ttft_ms=([\d.]+)")
_LATENCY_RE = re.compile(
    r"ai_execution_latency request_id=(\S+) execution_lane=(\S+) .*?ttft_ms=([\d.]+) total_ms=([\d.]+)"
)
_COMPLETE_RE = re.compile(r"ai_execution_complete request_id=(\S+) .*?ttft_ms=([\d.]+) total_ms=([\d.]+)")
_FALLBACK_RE = re.compile(r"dialogue_semantic_classifier_fallback")
_NOT_READY_RE = re.compile(r"(\w+)_future_not_ready_by_done")


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * (pct / 100)
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def _fmt(values: list[float], label: str) -> str:
    if not values:
        return f"{label}: no data"
    p50, p90 = _percentile(values, 50), _percentile(values, 90)
    return f"{label}  p50={p50:.0f}ms  p90={p90:.0f}ms  (n={len(values)})"


def main() -> int:
    source = open(sys.argv[1], encoding="utf-8") if len(sys.argv) > 1 else sys.stdin

    requests: dict[str, dict[str, float | str]] = defaultdict(dict)
    fallback_hours: list[str | None] = []
    not_ready_counts: dict[str, int] = defaultdict(int)
    has_timestamps = False
    total_lines = 0

    for raw in source:
        total_lines += 1
        ts_match = _TS_RE.search(raw)
        hour_bucket = None
        if ts_match:
            has_timestamps = True
            hour_bucket = ts_match.group(1)[:13]  # YYYY-MM-DDTHH

        if m := _FIRST_SSE_RE.search(raw):
            requests[m.group(1)]["first_sse_ms"] = float(m.group(2))
        if m := _RETRIEVAL_RE.search(raw):
            requests[m.group(1)]["retrieval_ms"] = float(m.group(2))
        if m := _TTFT_RE.search(raw):
            requests[m.group(1)]["ttft_ms"] = float(m.group(3))
            requests[m.group(1)]["execution_lane"] = m.group(2)
        if m := _LATENCY_RE.search(raw):
            requests[m.group(1)]["ttft_ms"] = float(m.group(3))
            requests[m.group(1)]["total_ms"] = float(m.group(4))
            requests[m.group(1)]["execution_lane"] = m.group(2)
        if m := _COMPLETE_RE.search(raw):
            requests[m.group(1)]["ttft_ms"] = float(m.group(2))
            requests[m.group(1)]["total_ms"] = float(m.group(3))
        if _FALLBACK_RE.search(raw):
            fallback_hours.append(hour_bucket)
        if m := _NOT_READY_RE.search(raw):
            not_ready_counts[m.group(1)] += 1

    if source is not sys.stdin:
        source.close()

    if total_lines == 0:
        print("No input read - pipe the grep output in, or pass a file path.")
        return 1

    ttft_all = [v for r in requests.values() if isinstance(v := r.get("ttft_ms"), float)]
    first_sse_all = [v for r in requests.values() if isinstance(v := r.get("first_sse_ms"), float)]
    retrieval_all = [v for r in requests.values() if isinstance(v := r.get("retrieval_ms"), float)]

    by_lane: dict[str, list[float]] = defaultdict(list)
    for r in requests.values():
        ttft, lane = r.get("ttft_ms"), r.get("execution_lane")
        if isinstance(ttft, float) and isinstance(lane, str):
            by_lane[lane].append(ttft)

    paired = held_back = 0
    for r in requests.values():
        ttft, total = r.get("ttft_ms"), r.get("total_ms")
        if isinstance(ttft, float) and isinstance(total, float) and total > 0:
            paired += 1
            if ttft >= 0.9 * total:
                held_back += 1

    print(f"Distinct request_ids seen: {len(requests)}\n")

    print(_fmt(ttft_all, "ttft_ms (overall)"))
    for lane in sorted(by_lane):
        print(f"  execution_lane={lane}: " + _fmt(by_lane[lane], "ttft_ms").split(": ", 1)[-1])
    print()

    print(_fmt(first_sse_all, "first_sse_ms"))
    print(_fmt(retrieval_all, "retrieval_ms"))
    print()

    if paired:
        pct = 100 * held_back / paired
        print(f"Held back until the end (ttft_ms within 10% of total_ms): {held_back}/{paired} = {pct:.1f}%")
    else:
        print("Held back until the end: no requests had both ttft_ms and total_ms logged")
    print()

    print(f"dialogue_semantic_classifier_fallback: {len(fallback_hours)} occurrences "
          f"(against {len(requests)} requests total - not a true %-of-follow-ups rate, "
          f"since only the failure path is logged, not every classifier call)")
    if has_timestamps:
        per_hour: dict[str, int] = defaultdict(int)
        for h in fallback_hours:
            if h:
                per_hour[h] += 1
        for hour in sorted(per_hour):
            print(f"  {hour}:00  {per_hour[hour]}")
        if len(fallback_hours) and len(requests) and len(fallback_hours) / max(1, len(requests)) > 0.10:
            print("  -> over 10% of requests - consider raising INTERACTIVE_CLASSIFIER_TIMEOUT "
                  "(app/services/openai_client.py) from 2.5s to 4s")
    else:
        print("  (no per-hour breakdown - rerun with `docker compose logs -t` for timestamps)")
    print()

    if not_ready_counts:
        for key in sorted(not_ready_counts):
            print(f"{key}_future_not_ready_by_done: {not_ready_counts[key]}")
    else:
        print("*_future_not_ready_by_done: none seen")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Controlled live generation QA for Goethe C1 Lesen parts.

Run from backend/python-ai:  python -m scripts.qa_goethe_lesen lesen_3 3

Calls the REAL reading adapter (LLM generation -> deterministic validation -> semantic
verification -> repair) exactly as production does, except that the part is temporarily marked
available so it can be exercised before its `available` flag is flipped. Needs no Supabase
(no user, no topic history). Writes one JSON per sample under audit/goethe-lesen/ containing the
full generated content plus diagnostics, for manual A/B/C review. Costs real OpenAI money.
"""

from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path
from time import perf_counter

from app.services import gen_timing
from app.services import german_exam_reading as reading
from app.services import german_exam_semantic_verify as verifier
from app.services.german_exam_generator import _dispatch_module
from app.services.german_exams import get_part, get_profile

OUT = Path(__file__).resolve().parents[3] / "audit" / "goethe-lesen"


def _capture(module, label: str, sink: list) -> None:
    """Record every raw LLM JSON answer made through `module.chat_json` (generation attempts and
    verifier verdicts), so a failed run can be diagnosed from the content the model actually produced."""
    real = module.chat_json

    def wrapped(*args, **kwargs):
        result = real(*args, **kwargs)
        sink.append({"stage": label, "data": result.data})
        return result

    module.chat_json = wrapped


def run(part_id: str, samples: int, start: int = 0, tag: str = "") -> None:
    profile = get_profile("goethe_c1")
    part = dataclasses.replace(get_part("goethe_c1", "reading", part_id), available=True)
    bank = profile.topic_banks["reading"]
    OUT.mkdir(parents=True, exist_ok=True)
    for i in range(samples):
        topic = dict(bank[(start + i * 5) % len(bank)])
        started = perf_counter()
        record: dict = {"partId": part_id, "topic": topic}
        attempts: list = []
        _capture(reading, "generation", attempts)
        _capture(verifier, "verifier", attempts)
        record["attempts"] = attempts
        with gen_timing.timed_request("reading", part_id) as timer:
            try:
                content, meta = _dispatch_module("reading")(profile, part, [], topic)
                record.update(status="ok", content=content, validation=meta)
                outcome = "ok"
            except Exception as exc:  # noqa: BLE001
                record.update(status="failed", error=f"{type(exc).__name__}: {exc}")
                outcome = "error"
            record["diagnostics"] = gen_timing.finish(timer, outcome)
        record["wallSeconds"] = round(perf_counter() - started, 1)
        path = OUT / f"{part_id}{tag}-{start + i + 1}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf8")
        d = record["diagnostics"]
        sem = (record.get("validation") or {}).get("semantic", {})
        print(
            f"[{part_id} #{start + i + 1}] {record['status']} topic={topic['topicId']} "
            f"wall={record['wallSeconds']}s cost=${d.get('estimatedCostUsd')} llmCalls={d.get('llmCalls')} totalMs={d.get('totalMs')} "
            f"detRepairs={(record.get('validation') or {}).get('deterministicRepairCount')} "
            f"semRepairs={sem.get('repairCount')} regens={sem.get('regenerationCount')} "
            f"issues={sem.get('issueCounts')} err={record.get('error', '')[:160]}"
        )


if __name__ == "__main__":
    run(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3, int(sys.argv[3]) if len(sys.argv) > 3 else 0, sys.argv[4] if len(sys.argv) > 4 else "")

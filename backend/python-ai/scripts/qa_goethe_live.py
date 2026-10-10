"""Bounded, cost-capped live-generation QA for ANY Goethe C1 part (all four
modules), across all task types implemented so far (Lesen 1-4, Hören 1-4,
Schreiben 1-2). Generalizes scripts/qa_goethe_lesen.py beyond Lesen and adds
hard --max-cost-usd / --max-samples caps so a human can run this later for
live qualification without risking an open-ended spend.

Run from backend/python-ai, e.g.:
    python -m scripts.qa_goethe_live --part hoeren_2 --max-samples 5 --max-cost-usd 2.00
    python -m scripts.qa_goethe_live --part schreiben_1 --max-samples 3 --max-cost-usd 1.00

Calls the REAL generation adapter (LLM generation -> deterministic validation
-> semantic verification -> repair) exactly as production does, except the
part is temporarily marked available so it can be exercised before its
`available` flag is flipped for real traffic. Needs no Supabase (no user, no
topic history, no inventory writes). Writes one JSON per sample under
audit/goethe-live/<part_id>/ for manual review.

THIS SCRIPT IS NOT RUN BY the AI agent that wrote it — it costs real OpenAI
money and is meant to be invoked by a human, deliberately, after reading the
generated samples it already has (or under supervision), never automatically.

--max-cost-usd is enforced BETWEEN samples using german_exam_gen_timing's own
`estimatedCostUsd` diagnostic (the same figure qa_goethe_lesen.py already
prints) — a running total that stops requesting further samples once the cap
would be exceeded. It cannot abort a single sample mid-flight (a single
generation call is already in progress once started), so treat the cap as a
budget for the NEXT sample to start under, not a hard mid-call kill switch.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path
from time import perf_counter

from app.services import gen_timing
from app.services.german_exam_generator import _dispatch_module
from app.services.german_exams import get_part, get_profile

OUT_ROOT = Path(__file__).resolve().parents[3] / "audit" / "goethe-live"

# module for each Goethe part_id, so --part alone is enough.
_MODULE_BY_PART_PREFIX = {
    "lesen": "reading",
    "hoeren": "listening",
    "schreiben": "writing",
    "sprechen": "speaking",
}


def _module_for_part(part_id: str) -> str:
    prefix = part_id.split("_")[0]
    module = _MODULE_BY_PART_PREFIX.get(prefix)
    if module is None:
        raise SystemExit(f"unrecognized Goethe part_id {part_id!r} (expected lesen_*/hoeren_*/schreiben_*/sprechen_*)")
    return module


def _capture(module_obj, label: str, sink: list) -> None:
    """Records every raw LLM JSON answer made through `module_obj.chat_json`
    (generation attempts and verifier verdicts), so a failed run can be
    diagnosed from the content the model actually produced."""
    real = module_obj.chat_json

    def wrapped(*args, **kwargs):
        result = real(*args, **kwargs)
        sink.append({"stage": label, "data": result.data})
        return result

    module_obj.chat_json = wrapped


def run(part_id: str, *, max_samples: int, max_cost_usd: float, start: int = 0, tag: str = "") -> None:
    profile = get_profile("goethe_c1")
    module = _module_for_part(part_id)
    part = dataclasses.replace(get_part("goethe_c1", module, part_id), available=True)
    bank = profile.topic_banks.get(module) or profile.topic_banks.get("reading") or ()
    out_dir = OUT_ROOT / part_id
    out_dir.mkdir(parents=True, exist_ok=True)

    spent_usd = 0.0
    produced = 0
    for i in range(max_samples):
        if spent_usd >= max_cost_usd:
            print(f"[{part_id}] stopping: spent ${spent_usd:.2f} would meet/exceed --max-cost-usd={max_cost_usd:.2f} before sample {start + i + 1}")
            break

        topic = dict(bank[(start + i * 5) % len(bank)]) if bank else {"topicId": "general", "label": "Allgemeines Thema"}
        started = perf_counter()
        record: dict = {"partId": part_id, "module": module, "topic": topic}
        attempts: list = []

        # Capture from every module's LLM-calling adapter (only the relevant one is ever hit per module,
        # capturing from all four is harmless and keeps this script from needing per-module branches).
        from app.services import german_exam_listening, german_exam_reading, german_exam_semantic_verify, german_exam_speaking, german_exam_writing
        for mod_obj, label in (
            (german_exam_reading, "generation"), (german_exam_listening, "generation"),
            (german_exam_writing, "generation"), (german_exam_speaking, "generation"),
            (german_exam_semantic_verify, "verifier"),
        ):
            _capture(mod_obj, label, attempts)
        record["attempts"] = attempts

        with gen_timing.timed_request(module, part_id) as timer:
            try:
                content, meta = _dispatch_module(module)(profile, part, [], topic)
                record.update(status="ok", content=content, validation=meta)
                outcome = "ok"
            except Exception as exc:  # noqa: BLE001
                record.update(status="failed", error=f"{type(exc).__name__}: {exc}")
                outcome = "error"
            record["diagnostics"] = gen_timing.finish(timer, outcome)
        record["wallSeconds"] = round(perf_counter() - started, 1)

        cost = record["diagnostics"].get("estimatedCostUsd") or 0.0
        spent_usd += cost
        produced += 1

        path = out_dir / f"{part_id}{tag}-{start + i + 1}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf8")
        sem = (record.get("validation") or {}).get("semantic", {})
        print(
            f"[{part_id} #{start + i + 1}] {record['status']} topic={topic.get('topicId')} "
            f"wall={record['wallSeconds']}s cost=${cost} cumulativeCost=${spent_usd:.2f} "
            f"detRepairs={(record.get('validation') or {}).get('deterministicRepairCount')} "
            f"semRepairs={sem.get('repairCount')} regens={sem.get('regenerationCount')} "
            f"issues={sem.get('issueCounts')} err={record.get('error', '')[:160]}"
        )

    print(f"[{part_id}] done: {produced} sample(s) written to {out_dir}, cumulative estimated cost ${spent_usd:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--part", required=True, help="Goethe part_id, e.g. hoeren_2 or schreiben_1")
    parser.add_argument("--max-samples", type=int, required=True, help="hard cap on number of samples to generate")
    parser.add_argument("--max-cost-usd", type=float, required=True, help="hard cap on cumulative estimated spend (USD)")
    parser.add_argument("--start", type=int, default=0, help="topic-bank offset, for resuming a QA run")
    parser.add_argument("--tag", default="", help="filename suffix, to keep separate QA rounds apart")
    args = parser.parse_args()
    if args.max_samples <= 0 or args.max_cost_usd <= 0:
        raise SystemExit("--max-samples and --max-cost-usd must both be positive")
    run(args.part, max_samples=args.max_samples, max_cost_usd=args.max_cost_usd, start=args.start, tag=args.tag)


if __name__ == "__main__":
    main()

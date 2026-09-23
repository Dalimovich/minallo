"""Bounded-cost live QA for one Digital TestDaF part. Writes local diagnostics
only — never seeds inventory, never flips a part's `available` flag, never
runs automatically (no test or CI path imports this module for its side
effects; it is a manual `python -m scripts.qa_testdaf_live ...` tool).

NOT EXECUTED as part of this offline phase. It exists so live qualification
can start immediately once API credits are restored, without writing a new
harness under time pressure then.

Every run MUST pass --max-cost-usd (> 0, <= 0.25) and --max-samples (> 0,
<= 1); scripts/qa_budget.py refuses anything else, and the budget is checked
BEFORE each new sample's generation call — a run that would exceed either
bound stops before making that call, not only after totalling cost
afterward. Usage-meter calls made during the run are relabeled to
testdaf_{lesen,hoeren,schreiben,sprechen}_qa (see `_MODULE_LABELS`) so they
are never attributed to `__main__` or to the generator module's own name.

python -m scripts.qa_testdaf_live --module reading --part lesen_1 \
    --env-file .env --max-cost-usd 0.25 --max-samples 1 --out diag_runs/testdaf
"""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path
from time import perf_counter
from typing import Any

from scripts.qa_budget import BudgetExceeded, QaBudget, add_budget_args, labeled_usage

# TestDaF-specific facts (which module needs which usage label) live only in
# this mapping to testdaf_digital's own module ids — nothing about the exam's
# structure itself (part counts, timings, ...) is duplicated here; that stays
# in testdaf_digital.py, read via get_part/get_profile below.
_MODULE_LABELS: dict[str, str] = {
    "reading": "testdaf_lesen_qa",
    "listening": "testdaf_hoeren_qa",
    "writing": "testdaf_schreiben_qa",
    "speaking": "testdaf_sprechen_qa",
}

DEFAULT_TOPIC: dict[str, str] = {"topicId": "qa_sample", "label": "Digitalisierung des Hochschulalltags"}


def _generator(module: str):
    """Every module's generator has the identical (profile, part, plan,
    topic) -> (content, meta) signature, so one dispatch table covers all
    four without four near-duplicate scripts."""
    if module == "reading":
        from app.services.german_exam_reading import generate_reading_part as fn
    elif module == "listening":
        from app.services.german_exam_listening import generate_listening_part as fn
    elif module == "writing":
        from app.services.german_exam_writing import generate_writing_part as fn
    elif module == "speaking":
        from app.services.german_exam_speaking import generate_speaking_part as fn
    else:
        raise ValueError(f"unknown module {module!r}")
    return fn


def run(args: argparse.Namespace) -> int:
    from dotenv import load_dotenv

    load_dotenv(args.env_file)

    from app.services import gen_timing
    from app.services.german_exams import get_part, get_profile

    profile = get_profile("testdaf_digital")
    part = get_part("testdaf_digital", args.module, args.part)
    label = _MODULE_LABELS[args.module]
    budget = QaBudget(max_cost_usd=args.max_cost_usd, max_samples=args.max_samples, label=label)
    generate = _generator(args.module)

    args.out.mkdir(parents=True, exist_ok=True)
    failures = 0
    terminated: dict[str, Any] | None = None

    with labeled_usage(label):
        for index in range(1, args.max_samples + 1):
            try:
                budget.guard_new_sample()
            except BudgetExceeded as exc:
                terminated = {"terminated": True, "reason": str(exc), "beforeSample": index}
                print(json.dumps(terminated), flush=True)
                break

            started = perf_counter()
            with gen_timing.timed_request(args.module, part.part_id) as timer:
                try:
                    content, meta = generate(profile, part, [], dict(DEFAULT_TOPIC))
                    status, error = "pass", None
                except Exception as exc:  # noqa: BLE001 — QA must record any generator failure, not crash
                    content, meta, status, error = None, None, "fail", f"{type(exc).__name__}: {exc}"
                diagnostics = gen_timing.finish(timer, status)

            budget.record_sample()
            budget.record_call(diagnostics.get("estimatedCostUsd"), sample=index, module=args.module, part=part.part_id)
            failures += status != "pass"

            record = {
                "profileId": profile.profile_id, "profileVersion": profile.profile_version,
                "module": args.module, "partId": part.part_id, "partAvailable": part.available,
                "sample": index, "status": status, "error": error,
                "content": content, "validation": meta, "diagnostics": diagnostics,
                "wallSeconds": round(perf_counter() - started, 3),
                "usageLabel": label, "generationId": uuid.uuid4().hex,
            }
            path = args.out / f"{args.module}-{part.part_id}-sample-{index}.json"
            path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
            print(json.dumps({
                "sample": index, "status": status,
                "costUsd": diagnostics.get("estimatedCostUsd"), "spentUsd": round(budget.spent_usd, 6),
                "error": error,
            }), flush=True)

            if budget.spent_usd >= budget.max_cost_usd:
                terminated = {"terminated": True, "reason": "cost budget reached after this sample", "afterSample": index}
                print(json.dumps(terminated), flush=True)
                break

    summary_path = args.out / f"{args.module}-{part.part_id}-summary.json"
    summary_path.write_text(json.dumps({
        "module": args.module, "partId": part.part_id, "usageLabel": label,
        "samplesRun": budget.samples_run, "maxSamples": budget.max_samples,
        "spentUsd": round(budget.spent_usd, 6), "maxCostUsd": budget.max_cost_usd,
        "failures": failures, "terminated": terminated,
        # Human inspection and latency/cost acceptance remain required; this script never
        # sets a release gate itself.
        "releaseGatePassed": False,
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    return int(failures > 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--module", required=True, choices=sorted(_MODULE_LABELS))
    parser.add_argument("--part", required=True, help="e.g. lesen_1, hoeren_3, schreiben_1, sprechen_5")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    add_budget_args(parser)
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())

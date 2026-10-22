"""Live QA for a profile's reading MC part, without inventory or database writes.

python -m scripts.qa_reading_mc PROFILE PART --env-file PATH --out PATH
Calls the normal adapter and envelope; availability remains a release gate.
Raw LLM outputs, timing/token estimates and repairs are saved for manual review.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from copy import deepcopy
import json
from pathlib import Path
from time import perf_counter
from unittest.mock import patch
import uuid


def run(args):
    from dotenv import load_dotenv
    load_dotenv(args.env_file)
    from app.services import gen_timing, llm_json
    from app.services import german_exam_reading as reading
    from app.services import german_exam_semantic_verify as verifier
    from app.services import german_exam_semantic_repair as repair
    from app.services.german_exam_generator import _envelope
    from app.services.german_exams import get_part, get_profile

    profile = get_profile(args.profile)
    part = get_part(args.profile, "reading", args.part)
    topics = args.topics or [
        "Gemeinschaftliche Nutzung wissenschaftlicher Geräte an Hochschulen",
        "Städtische Grünflächen und die Bewertung ihrer Kühlwirkung",
        "Offene Forschungsdaten und die Grenzen ihrer Wiederverwendung",
    ]
    args.out.mkdir(parents=True, exist_ok=True)
    failures = 0
    for index, label in enumerate(topics, 1):
        record = {"profileId": profile.profile_id, "partId": part.part_id, "attempts": []}
        topic = {"topicId": f"qa_{index}", "label": label}
        def capture(real, stage):
            def wrapped(*a, **kw):
                result = real(*a, **kw)
                record["attempts"].append({"stage": stage, "data": deepcopy(result.data)})
                return result
            return wrapped
        started = perf_counter()
        with ExitStack() as stack:
            # Provider usage is already recorded by gen_timing; do not write app telemetry to DB.
            stack.enter_context(patch.object(llm_json, "record_usage", lambda **kw: None))
            for module, label in ((reading, "generation_or_deterministic_repair"), (verifier, "semantic_verification"), (repair, "semantic_repair")):
                stack.enter_context(patch.object(module, "chat_json", capture(module.chat_json, label)))
            with gen_timing.timed_request("reading", part.part_id) as timer:
                try:
                    content, meta = reading.generate_reading_part(profile, part, [], topic)
                    record.update(status="pass", content=content, validation=meta,
                                  envelope=_envelope(profile, "reading", part, "adaptive_practice", [], None, topic, content, meta, uuid.uuid4().hex))
                except Exception as exc:
                    record.update(status="fail", error=f"{type(exc).__name__}: {exc}")
                record["diagnostics"] = gen_timing.finish(timer, record["status"])
        failures += record["status"] != "pass"
        record["wallSeconds"] = round(perf_counter() - started, 3)
        path = args.out / f"sample-{index}.json"
        path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"sample": index, "status": record["status"], "seconds": record["wallSeconds"],
                          "costUsd": None if record["diagnostics"]["unpricedModels"] else record["diagnostics"]["estimatedCostUsd"], "validation": record.get("validation"),
                          "error": record.get("error")}), flush=True)

    return int(failures > 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile")
    parser.add_argument("part")
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--topics", nargs="+")
    raise SystemExit(run(parser.parse_args()))

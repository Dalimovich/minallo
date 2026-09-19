"""Phase 2.5 measurement: does reasoning_effort actually explain semantic
verification's completion-token/latency variance, and does dropping it to
"low" preserve quality?

Two checks, both against real content (no mocks):
1. Re-verifies the 9 real samples from a prior live release run (no new
   generation calls) under "medium" vs "low" reasoning_effort.
2. Re-verifies the 3 required injected-failure fixtures under both levels
   (the release-gate regression: do they still get caught?).

Writes-only; does not touch production defaults.

Run from backend/python-ai:
    .\.venv\Scripts\python.exe -m scripts.measure_reasoning_effort
"""
import json
import sys
from pathlib import Path
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))

from app.services import german_exam_semantic_verify as verifier
from app.services.german_exam_profiles import get_part, get_profile
from app.services import llm_json
from german_exam_semantic_fixtures import bad_content

SOURCE = Path("scripts/diag_runs/german-semantic-release.json")
OUTPUT = Path("scripts/diag_runs/reasoning-effort-comparison.json")

FIXTURE_CASES = [
    ("hv1", "AMBIGUOUS_MAPPING"),
    ("hv2", "IMPLAUSIBLE_DISTRACTOR"),
    ("hv3", "DUPLICATE_INFORMATION"),
]


def _issue_codes(result):
    issues = list(result.part_wide_issues)
    issues.extend(issue for item in result.items for issue in item.issues)
    return [i.code for i in issues]


def main():
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    samples = [s for s in data["samples"] if "content" in s]
    profile = get_profile("telc_c1_hochschule")
    original = llm_json.chat_json

    results = []
    fixture_results = []
    for effort in ("medium", "low"):
        def call(effort=effort, **kwargs):
            kwargs["reasoning_effort"] = effort
            return original(**kwargs)

        verifier.chat_json = call

        for sample in samples:
            part = get_part(profile.profile_id, "listening", sample["part"])
            start = perf_counter()
            result = verifier.verify_semantic(part, sample["content"])
            elapsed = perf_counter() - start
            codes = _issue_codes(result)
            results.append({
                "effort": effort, "part": sample["part"], "index": sample["index"],
                "seconds": elapsed, "passed": result.passed, "issueCodes": codes,
            })
            print(f"effort={effort} part={sample['part']} idx={sample['index']} "
                  f"seconds={elapsed:.2f} passed={result.passed} issues={codes}", flush=True)

        for part_id, code in FIXTURE_CASES:
            part = get_part(profile.profile_id, "listening", part_id)
            content = bad_content(part_id, code)
            result = verifier.verify_semantic(part, content)
            codes = _issue_codes(result)
            caught = code in codes
            fixture_results.append({
                "effort": effort, "part": part_id, "expectedCode": code, "caught": caught, "codes": codes,
            })
            print(f"[fixture] effort={effort} part={part_id} expected={code} caught={caught} codes={codes}", flush=True)

    verifier.chat_json = original
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"samples": results, "fixtures": fixture_results},
                                  ensure_ascii=False, indent=2), encoding="utf-8")

    for effort in ("medium", "low"):
        subset = [r for r in results if r["effort"] == effort]
        total_s = sum(r["seconds"] for r in subset)
        print(f"\neffort={effort}: {len(subset)} calls, {total_s:.2f}s total, {total_s/len(subset):.2f}s avg")
        fx = [r for r in fixture_results if r["effort"] == effort]
        print(f"effort={effort}: fixtures caught {sum(r['caught'] for r in fx)}/{len(fx)}")


if __name__ == "__main__":
    main()

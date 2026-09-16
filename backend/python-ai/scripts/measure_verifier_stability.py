"""Phase 2.5b: quantify semantic-verifier stability at the CURRENT production
reasoning_effort ("medium" — not touched here). Does NOT redesign the
verifier; measurement only.

Fixed labeled corpus, all real content (no mocks):
- 3 injected fixtures (definitionally defective): hv1/AMBIGUOUS_MAPPING,
  hv2/IMPLAUSIBLE_DISTRACTOR, hv3/DUPLICATE_INFORMATION.
- 2 "real_disputed" samples: final accepted content from the release run
  that passed clean on its ORIGINAL first verify (zero repairs), but that
  scripts/measure_reasoning_effort.py's medium-effort re-verification later
  flagged with real issues on the same content
  (hv2 idx=2 -> UNSUPPORTED_CORRECT_ANSWER/IMPLAUSIBLE_DISTRACTOR;
   hv3 idx=0 -> MULTIPLE_DEFENSIBLE_ANSWERS). Labeled "disputed" rather than
  "known_bad" because we have no independent ground truth beyond one prior
  verifier call -- the point of this script is precisely to see how often
  each verdict recurs.
- 5 "known_good" samples: release-run content that passed clean on the
  FIRST verify call with zero deterministic or semantic repairs ever
  (hv1 idx=0/1, hv2 idx=0, hv3 idx=1/2).

Each corpus item is re-verified REPEATS times (default 5) at production
reasoning_effort. Measures pass/fail agreement, false-negative rate on
known-bad/disputed items, false-positive rate on known-good items, issue
code/severity agreement, per-task-type variance, and latency/token
variance. Writes-only; does not change production verifier behavior.

Run from backend/python-ai:
    .\.venv\Scripts\python.exe -m scripts.measure_verifier_stability
"""
import json
import sys
from collections import Counter
from pathlib import Path
from statistics import mean, pstdev
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))

from app.services import german_exam_semantic_verify as verifier
from app.services.german_exam_profiles import get_part, get_profile
from german_exam_semantic_fixtures import bad_content

RELEASE_SOURCE = Path("scripts/diag_runs/german-semantic-release.json")
OUTPUT = Path("scripts/diag_runs/verifier-stability.json")
REPEATS = 5

REAL_DISPUTED = [
    {"part": "hv2", "index": 2, "priorCodes": ["UNSUPPORTED_CORRECT_ANSWER", "IMPLAUSIBLE_DISTRACTOR"]},
    {"part": "hv3", "index": 0, "priorCodes": ["MULTIPLE_DEFENSIBLE_ANSWERS"]},
]
KNOWN_GOOD = [
    {"part": "hv1", "index": 0}, {"part": "hv1", "index": 1},
    {"part": "hv2", "index": 0},
    {"part": "hv3", "index": 1}, {"part": "hv3", "index": 2},
]


def _issue_codes(result):
    issues = list(result.part_wide_issues)
    issues.extend(issue for item in result.items for issue in item.issues)
    return [(i.code, i.severity) for i in issues]


def build_corpus():
    release = json.loads(RELEASE_SOURCE.read_text(encoding="utf-8"))
    by_key = {(s["part"], s["index"]): s["content"] for s in release["samples"]}
    profile = get_profile("telc_c1_hochschule")

    corpus = []
    for part_id, code in [("hv1", "AMBIGUOUS_MAPPING"), ("hv2", "IMPLAUSIBLE_DISTRACTOR"),
                           ("hv3", "DUPLICATE_INFORMATION")]:
        corpus.append({
            "label": "injected_bad", "part": part_id, "id": f"injected-{part_id}",
            "content": bad_content(part_id, code), "expectedCodes": [code],
        })
    for spec in REAL_DISPUTED:
        corpus.append({
            "label": "real_disputed", "part": spec["part"],
            "id": f"real-disputed-{spec['part']}-{spec['index']}",
            "content": by_key[(spec["part"], spec["index"])], "expectedCodes": spec["priorCodes"],
        })
    for spec in KNOWN_GOOD:
        corpus.append({
            "label": "known_good", "part": spec["part"],
            "id": f"known-good-{spec['part']}-{spec['index']}",
            "content": by_key[(spec["part"], spec["index"])], "expectedCodes": [],
        })
    return profile, corpus


def main():
    profile, corpus = build_corpus()
    runs = []
    for item in corpus:
        part = get_part(profile.profile_id, "listening", item["part"])
        for rep in range(REPEATS):
            start = perf_counter()
            result = verifier.verify_semantic(part, item["content"])
            elapsed = perf_counter() - start
            codes = _issue_codes(result)
            run = {
                "id": item["id"], "label": item["label"], "part": item["part"], "rep": rep,
                "seconds": elapsed, "passed": result.passed,
                "codes": [c for c, _ in codes], "severities": [sv for _, sv in codes],
            }
            runs.append(run)
            print(f"[{item['label']}] {item['id']} rep={rep} seconds={elapsed:.2f} "
                  f"passed={result.passed} codes={run['codes']}", flush=True)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"corpus": [{k: v for k, v in c.items() if k != "content"} for c in corpus],
                                   "runs": runs}, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n=== Per-item agreement ===")
    by_id = {}
    for r in runs:
        by_id.setdefault(r["id"], []).append(r)
    for item in corpus:
        item_runs = by_id[item["id"]]
        pass_counts = Counter(r["passed"] for r in item_runs)
        code_sets = [tuple(sorted(r["codes"])) for r in item_runs]
        agree = Counter(code_sets).most_common(1)[0][1] / len(item_runs)
        secs = [r["seconds"] for r in item_runs]
        print(f"{item['label']:14s} {item['id']:28s} passedCounts={dict(pass_counts)} "
              f"codeAgreement={agree:.0%} seconds(mean/stdev)={mean(secs):.2f}/{pstdev(secs):.2f}")

    print("\n=== False-negative rate on injected_bad + real_disputed (known-bad item passed clean) ===")
    for label in ("injected_bad", "real_disputed"):
        items = [c for c in corpus if c["label"] == label]
        total = 0
        false_negatives = 0
        for item in items:
            item_runs = by_id[item["id"]]
            total += len(item_runs)
            false_negatives += sum(1 for r in item_runs if r["passed"])
        rate = false_negatives / total if total else 0
        print(f"{label}: {false_negatives}/{total} runs passed clean despite known/prior defect ({rate:.0%})")

    print("\n=== False-positive rate on known_good (clean item flagged) ===")
    items = [c for c in corpus if c["label"] == "known_good"]
    total = sum(len(by_id[i["id"]]) for i in items)
    false_positives = sum(1 for i in items for r in by_id[i["id"]] if not r["passed"])
    rate = false_positives / total if total else 0
    print(f"known_good: {false_positives}/{total} runs flagged a clean item ({rate:.0%})")

    print("\n=== Variance by task type ===")
    for part_id in ("hv1", "hv2", "hv3"):
        part_runs = [r for r in runs if r["part"] == part_id]
        by_item = {}
        for r in part_runs:
            by_item.setdefault(r["id"], []).append(r)
        disagreeing_items = sum(
            1 for item_runs in by_item.values()
            if len({tuple(sorted(r["codes"])) for r in item_runs}) > 1
        )
        print(f"{part_id}: {disagreeing_items}/{len(by_item)} items show run-to-run code disagreement")


if __name__ == "__main__":
    main()

"""Zero-cost rescoring of the already-saved 2026-10-22 Jev evaluation
(reports/jev-corpus-evaluation-2026-10-22.json) through the real, trusted
policy compiler -- NO new API calls; reuses only data already paid for.

2026-10-23 review findings this implements:

1. Jev's raw ``final_answer_permitted`` noul must never be the release-
   authorization decision -- see scripts/jev_policy_adapter.py (the shared
   adapter this script now uses) for the real fix.
2. The saved Jev answers were collected with NO assistant turn at all in
   their conversation ``state`` (jev_corpus_evaluation.py only ever
   appended student lines), while the deterministic baseline's history had
   a DIFFERENT (and, until the 2026-10-23 transcript fix, gold-leaking)
   shape. The two were never comparable. This script's numbers below are
   therefore STILL NOT a fair, completed Arm C -- they are a diagnostic
   read of the existing adapter/scorer logic against data collected under
   an uneven, now-superseded context. A fair Arm C needs a real Jev re-run
   against scripts.semantic_blind_ab_transcript's shared history, which is
   a new paid call requiring its own approval (see the written-up report).
3. Four categories are tracked explicitly per turn, never silently folded
   into one accuracy number -- see jev_policy_adapter.py's docstring:
   ``target_unverified``, ``objective_unsupported``,
   ``permission_change_untestable``, ``is_multi_target``. A turn flagged in
   any of these is EXCLUDED from the "cleanly evaluable" headline accuracy
   and reported in its own bucket instead of being scored as if absent
   restriction information were evidence of permission.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.jev_policy_adapter import (  # noqa: E402
    is_permission_change_untestable, load_corpus, load_documents, rescore_jev_answer,
)

SAVED = json.loads((ROOT / "reports/jev-corpus-evaluation-2026-10-22.json").read_text(encoding="utf-8"))
DOCUMENTS = load_documents()
CORPUS = load_corpus()
_SCENARIO_BY_ID = {c["id"]: c for c in CORPUS["cases"]}

_RELEASE_TO_FINAL_ANSWER = {
    "permitted": "permitted", "prohibited": "prohibited",
    "partial": "unspecified", "ambiguous_expect_clarify_or_both": "unspecified",
}


def main() -> None:
    rows: list[dict] = []
    excluded_counts = {
        "multi_target": 0, "permission_change_untestable": 0,
        "objective_unsupported": 0, "target_unverified": 0,
    }
    counts = {
        "turns": 0, "target_match": 0, "objective_match": 0,
        "final_answer_match_raw_noul_gate": 0, "final_answer_match_compiled_policy": 0,
        "all_match_raw_noul_gate": 0, "all_match_compiled_policy": 0,
    }

    for turn in SAVED["turns"]:
        scenario = _SCENARIO_BY_ID[turn["scenario"]]
        document = DOCUMENTS[scenario["document"]]
        expected = turn["expected"]
        is_multi_target = len(expected) > 1
        gold_form = expected[0]["form"]  # single-target turns only reach here as "evaluable"
        turn_index = turn["turn"] - 1  # corpus "n" is 1-based
        permission_untestable = is_permission_change_untestable(
            category=turn["category"], turn_index=turn_index,
        )
        expected_final_answers = {_RELEASE_TO_FINAL_ANSWER.get(e["release"], "unspecified") for e in expected}

        jev = turn["jev_result"]
        rescored = rescore_jev_answer(
            jev_target=jev["target"], jev_objective=jev["objective"], gold_form=gold_form,
            message=turn["student"], document=document,
        )

        target_match = turn["score"]["target_match"]
        objective_match = turn["score"]["objective_match"]
        raw_final_match = turn["score"]["final_answer_match"]
        compiled_final_match = target_match and (
            rescored.compiled_final_answer in expected_final_answers or "unspecified" in expected_final_answers
        )

        excluded_reasons = []
        if is_multi_target:
            excluded_reasons.append("multi_target")
        if permission_untestable:
            excluded_reasons.append("permission_change_untestable")
        if rescored.objective_unsupported:
            excluded_reasons.append("objective_unsupported")
        # target_unverified is reported (below) but deliberately NOT a
        # headline-exclusion reason on its own: a correctly-grounded
        # "unresolved" degrading to compile_policy's most-restrictive
        # fallback is the compiler working as intended, not an unevaluable
        # case. Multi-target/permission/unsupported-objective ARE excluded
        # because no amount of correct compiling can fix an input the
        # schema structurally cannot carry.

        row = {
            "scenario": turn["scenario"], "category": turn["category"], "turn": turn["turn"],
            "student": turn["student"],
            "is_multi_target": is_multi_target,
            "permission_change_untestable": permission_untestable,
            "objective_unsupported": rescored.objective_unsupported,
            "target_unverified": rescored.target_unverified,
            "jev_target": jev["target"], "jev_objective": jev["objective"],
            "expected_final_answers": sorted(expected_final_answers),
            "raw_final_answer": jev["final_answer"], "raw_final_answer_noul": jev.get("final_answer_noul"),
            "compiled_final_answer": rescored.compiled_final_answer, "compiled_state": rescored.compiled_state,
            "policy_audit": list(rescored.policy_audit),
            "target_match": target_match, "objective_match": objective_match,
            "raw_final_match": raw_final_match, "compiled_final_match": compiled_final_match,
        }
        rows.append(row)

        if excluded_reasons:
            for reason in excluded_reasons:
                excluded_counts[reason] += 1
            continue  # excluded from headline accuracy -- see module docstring

        if rescored.target_unverified:
            excluded_counts["target_unverified"] += 1  # reported, still scored below

        counts["turns"] += 1
        counts["target_match"] += target_match
        counts["objective_match"] += objective_match
        counts["final_answer_match_raw_noul_gate"] += raw_final_match
        counts["final_answer_match_compiled_policy"] += compiled_final_match
        counts["all_match_raw_noul_gate"] += target_match and objective_match and raw_final_match
        counts["all_match_compiled_policy"] += target_match and objective_match and compiled_final_match

    n = counts["turns"]
    summary = {
        "cleanly_evaluable_turns_scored": n,
        "excluded_from_headline": excluded_counts,
        "target_accuracy": round(counts["target_match"] / n, 4),
        "objective_accuracy": round(counts["objective_match"] / n, 4),
        "final_answer_accuracy_raw_noul_gate": round(counts["final_answer_match_raw_noul_gate"] / n, 4),
        "final_answer_accuracy_compiled_policy": round(counts["final_answer_match_compiled_policy"] / n, 4),
        "all_fields_accuracy_raw_noul_gate": round(counts["all_match_raw_noul_gate"] / n, 4),
        "all_fields_accuracy_compiled_policy": round(counts["all_match_compiled_policy"] / n, 4),
        "caveat": (
            "This is a diagnostic re-read of saved data collected under an "
            "uneven context (no assistant turns at all), NOT a fair, "
            "completed Arm C. See module docstring."
        ),
    }

    changed = [
        r for r in rows
        if not (r["is_multi_target"] or r["permission_change_untestable"] or r["objective_unsupported"])
        and r["raw_final_match"] != r["compiled_final_match"]
    ]
    out = {"summary": summary, "changed_by_rescoring": changed, "all_rows": rows}
    out_path = ROOT / "reports" / "jev-policy-compiler-rescoring-2026-10-23.json"
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=True), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"\n{len(changed)} cleanly-evaluable turns changed final_answer verdict after compiling through the real policy.")
    print(f"Full results written to {out_path}")


if __name__ == "__main__":
    main()

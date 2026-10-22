"""Jev-assisted interpretation accuracy vs the deterministic baseline
(2026-10-22) -- REAL, BILLED calls to the live Jev API (one call per
turn, 64 total). Mirrors semantic_intent_deterministic_baseline.py's
exact scoring (target/objective/final_answer, same corpus, same gold
labels) so the two are directly comparable.

Cost: confirmed empirically via one prior smoke-test call at ~370 input
tokens / $0.000016. 64 turns at a similar size is expected well under
$0.01 total -- printed running total below so this is verified, not
assumed.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import jev_client  # noqa: E402

CORPUS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))
DOCUMENTS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))

_RELEASE_TO_FINAL_ANSWER = {
    "permitted": "permitted", "prohibited": "prohibited",
    "partial": "unspecified", "ambiguous_expect_clarify_or_both": "unspecified",
}
_FORM_TO_OBJECTIVE = {
    "hint": "hint", "method_explanation": "explain", "full_solution": "solve",
    "confirmation": "explain", "summary": "summarize",
    "quiz_start": "other", "answer_check": "other",
}
_OBJECTIVES = ("hint", "explain", "solve", "summarize", "other")


def _exercise_options(document: dict) -> dict[str, str | None]:
    options: dict[str, str | None] = {}
    for key, ex in (document.get("exercises") or {}).items():
        options[key] = ex.get("prompt")
    for key in (document.get("sections") or {}):
        options[f"section:{key}"] = "A content/concept section, not a numbered exercise"
    options["document"] = "The document as a whole, not any one exercise or section"
    options["none"] = "No specific exercise or section is identifiable from the message"
    return options


def _ask_jev(client: jev_client.JevClient, *, state: str, document: dict) -> dict:
    questions = {
        "target": jev_client.ChoiceQuestion(
            instructions=(
                "Which exercise number, section, or item is the student's most recent "
                "message actually about? Use conversation history for context."
            ),
            options=_exercise_options(document),
        ),
        "objective": jev_client.ChoiceQuestion(
            instructions="What is the student asking for?",
            options={
                "hint": "A hint or partial help, not the final answer",
                "explain": "An explanation of a concept or method",
                "solve": "The complete worked solution or final answer",
                "summarize": "A summary of content",
                "other": "Something else (confirmation, quiz, correction, etc.)",
            },
        ),
        "final_answer_permitted": jev_client.NoulQuestion(
            instructions=(
                "The student should be shown the final numeric answer or result right now "
                "(not just a hint or method explanation)."
            ),
        ),
    }
    result = client.ask(state=state, questions=questions)
    target = result.answers["target"].choice or "none"
    objective = result.answers["objective"].choice or "other"
    final_answer_noul = result.answers["final_answer_permitted"].noul
    final_answer = "permitted" if (final_answer_noul or 0) >= 0.5 else "prohibited"
    return {
        "target": target, "objective": objective, "final_answer": final_answer,
        "final_answer_noul": final_answer_noul,
        "target_confidence": result.answers["target"].confidence,
        "objective_confidence": result.answers["objective"].confidence,
        "input_tokens": result.input_tokens, "output_tokens": result.output_tokens,
    }


def _score_turn(turn: dict, result: dict) -> dict:
    expected_targets = {str(e["target"]) for e in turn["expected"]}
    expected_objectives = {_FORM_TO_OBJECTIVE.get(e["form"], "other") for e in turn["expected"]}
    expected_final_answers = {_RELEASE_TO_FINAL_ANSWER.get(e["release"], "unspecified") for e in turn["expected"]}

    target_match = result["target"] in expected_targets
    objective_match = target_match and result["objective"] in expected_objectives
    final_answer_match = (
        target_match
        and (result["final_answer"] in expected_final_answers or "unspecified" in expected_final_answers)
    )
    return {
        "target_match": target_match, "objective_match": objective_match,
        "final_answer_match": final_answer_match,
        "all_match": target_match and objective_match and final_answer_match,
        "expected_targets": sorted(expected_targets), "expected_objectives": sorted(expected_objectives),
        "expected_final_answers": sorted(expected_final_answers),
    }


def main() -> None:
    client = jev_client.construct_client()
    results = []
    overall = {"turns": 0, "target_match": 0, "objective_match": 0, "final_answer_match": 0, "all_match": 0}
    category_totals: dict[str, dict[str, int]] = {}
    total_input_tokens = 0
    total_output_tokens = 0

    try:
        for scenario in CORPUS["cases"]:
            document = DOCUMENTS[scenario["document"]]
            category = scenario["category"]
            category_totals.setdefault(category, {"turns": 0, "all_match": 0})
            history: list[str] = []
            for turn in scenario["turns"]:
                state = "\n".join(history + [f"Student (current message): {turn['student']}"])
                started = time.perf_counter()
                try:
                    jev_result = _ask_jev(client, state=state, document=document)
                    error = None
                except Exception as exc:  # noqa: BLE001
                    jev_result = {
                        "target": "none", "objective": "other", "final_answer": "prohibited",
                        "input_tokens": 0, "output_tokens": 0,
                    }
                    error = f"{type(exc).__name__}: {exc}"
                elapsed_ms = (time.perf_counter() - started) * 1000
                total_input_tokens += jev_result.get("input_tokens", 0)
                total_output_tokens += jev_result.get("output_tokens", 0)

                score = _score_turn(turn, jev_result)
                record = {
                    "scenario": scenario["id"], "category": category, "language": scenario["language"],
                    "turn": turn["n"], "student": turn["student"], "expected": turn["expected"],
                    "jev_result": jev_result, "score": score, "latency_ms": round(elapsed_ms, 1), "error": error,
                }
                results.append(record)

                overall["turns"] += 1
                category_totals[category]["turns"] += 1
                for key in ("target_match", "objective_match", "final_answer_match", "all_match"):
                    if score[key]:
                        overall[key] += 1
                if score["all_match"]:
                    category_totals[category]["all_match"] += 1

                running_cost = total_input_tokens / 1_000_000 * 0.042
                print(
                    f"[{overall['turns']}/64] {scenario['id']} t{turn['n']} "
                    f"target={jev_result['target']!r} (exp {sorted({str(e['target']) for e in turn['expected']})}) "
                    f"match={score['all_match']} running_cost=${running_cost:.6f}",
                    flush=True,
                )
                history.append(f"Student: {turn['student']}")
    finally:
        client.close()

    summary = {
        "total_turns": overall["turns"],
        "target_accuracy": round(overall["target_match"] / overall["turns"], 4),
        "objective_accuracy": round(overall["objective_match"] / overall["turns"], 4),
        "final_answer_accuracy": round(overall["final_answer_match"] / overall["turns"], 4),
        "all_fields_accuracy": round(overall["all_match"] / overall["turns"], 4),
        "total_input_tokens": total_input_tokens, "total_output_tokens": total_output_tokens,
        "total_cost_usd": round(total_input_tokens / 1_000_000 * 0.042, 6),
        "by_category": {
            cat: {"turns": v["turns"], "all_fields_accuracy": round(v["all_match"] / v["turns"], 4)}
            for cat, v in sorted(category_totals.items())
        },
    }

    out_path = ROOT / "reports" / "jev-corpus-evaluation-2026-10-22.json"
    out_path.write_text(json.dumps({"summary": summary, "turns": results}, indent=2, ensure_ascii=True), encoding="utf-8")
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    print(f"\nFull results written to {out_path}")


if __name__ == "__main__":
    main()

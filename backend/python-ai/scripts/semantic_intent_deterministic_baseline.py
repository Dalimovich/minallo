"""Semantic Student Intent Layer -- deterministic-path interpretation
accuracy baseline (2026-10-22), zero-cost (no model calls of any kind).

Gap this closes: the existing frozen 35-scenario/64-turn corpus
(tests/fixtures/semantic_blind_ab_corpus.json) already has an A/B dry-run
harness (tests/test_semantic_blind_ab_full_corpus_dry_run.py), but that
harness tests RELEASE-GATE MECHANICS given an already-correct policy
(config B injects the ground-truth-derived policy directly, bypassing
real interpretation entirely) or a synthetic draft BUILT FROM the
expected answer (config A). Neither measures whether the system itself
correctly figures out which exercise the student means, what they're
asking for, and what should be released -- the actual question this
baseline answers.

This script runs each corpus turn through the REAL deterministic
interpretation stack (dialogue_state.resolve_dialogue ->
student_intent.interpret_student_intent(mode="off") ->
diagnostic_policy.adapt_deterministic_intent), the exact same functions
production uses on the SEMANTIC_INTENT_MODE="off"/deterministic-fallback
path, with semantic escalation never invoked (mode="off" forces this;
confirmed by reading interpret_student_intent's own signature -- "off"
is what interpret_turn_authoritatively itself passes for its own
deterministic-fallback branch, not a special test-only mode). Zero
OpenAI/model calls -- no httpx.Client.send mock is even needed because
nothing in this call path can reach one.

Multi-turn history (2026-10-23 fix): built by ``scripts.semantic_blind_ab_
transcript.build_history_turns``, shared with every other eval arm, instead
of this script's own original ``_placeholder_assistant_text``, which
literally wrote the gold ``expected`` target into the synthetic assistant
reply (e.g. ``"[placeholder prior answer about 4]"``) -- handing turn 2+ of
24 of the corpus's 35 scenarios the correct exercise identity for free,
before the interpreter under test ever had to resolve it. The shared builder
never reads ``expected``/``verifiedAnswer`` at all; see its own docstring.
The original 2026-10-22 report (same filename without "-fixed-transcript")
is left in place, not deleted, and must not be cited as this corpus's
single-turn-interpretation accuracy -- only turn-1-of-each-scenario numbers
from it were ever unaffected by this leak.

Usage: run from backend/python-ai/ with the project's venv:
    py -3.12 scripts/semantic_intent_deterministic_baseline.py
Writes reports/semantic-intent-deterministic-baseline-<date>.json and
prints a summary to stdout.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.dialogue_state import resolve_dialogue  # noqa: E402
from app.services.diagnostic_policy import adapt_deterministic_intent  # noqa: E402
from app.services.policy_compiler import compile_policy  # noqa: E402
from app.services.semantic_call_support import needs_semantic_escalation  # noqa: E402
from app.services.student_intent import interpret_student_intent  # noqa: E402
from scripts.semantic_blind_ab_transcript import build_history_turns  # noqa: E402

CORPUS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_text(encoding="utf-8"))
DOCUMENTS = json.loads((ROOT / "tests/fixtures/semantic_blind_ab_documents.json").read_text(encoding="utf-8"))
USER_ID = "00000000-0000-4000-8000-00000000d001"

# Same mapping tables as tests/test_semantic_blind_ab_full_corpus_dry_run.py
# (resolved_student_intent.py's real Literal types) -- kept in sync
# deliberately rather than re-derived, so a baseline "pass" means the
# same thing in both harnesses.
_RELEASE_TO_FINAL_ANSWER = {
    "permitted": "permitted", "prohibited": "prohibited",
    "partial": "unspecified", "ambiguous_expect_clarify_or_both": "unspecified",
}
_FORM_TO_OBJECTIVE = {
    "hint": "hint", "method_explanation": "explain", "full_solution": "solve",
    "confirmation": "explain", "summary": "summarize",
    "quiz_start": "other", "answer_check": "other",
}


def _authorized_labels(document: dict) -> frozenset[str]:
    return frozenset((document.get("exercises") or {}).keys())


def _run_turn(question: str, *, previous_turns: list[dict], document: dict) -> dict:
    dialogue = resolve_dialogue(question, previous_turns=previous_turns)
    student_intent = interpret_student_intent(
        question, dialogue=dialogue, resolved_access=None,
        has_visible_context=True, mode="off",
        previous_turns=previous_turns, user_id=USER_ID,
    )
    resolved = adapt_deterministic_intent(
        message=question, dialogue=dialogue, student_intent=student_intent,
        authorized_exercise_labels=_authorized_labels(document),
        has_visible_context=True,
    )
    # Raw per-action fields (what the interpreter itself concluded) AND the
    # compiled, EFFECTIVE policy (what the student would actually see --
    # compile_policy's fallback rules, e.g. hint_objective_fallback/
    # explain_objective_fallback, fill in final_answer for many actions
    # that leave it "unspecified" at this layer; scoring only the raw
    # value would understate real system behavior).
    policy = compile_policy(resolved, turn_ledger=None, conversation_id=None)
    actions = []
    for action in resolved.actions:
        actions.append({
            "target": action.target, "objective": action.objective, "state": action.state,
            "final_answer": action.release.final_answer,
        })
    compiled_actions = []
    for action in policy.actions:
        compiled_actions.append({
            "target": action.target, "objective": action.objective,
            "final_answer": action.release.final_answer,
        })
    escalates = needs_semantic_escalation(
        question, has_unresolved_reference=bool(dialogue.referent_type != "unknown"),
    )
    return {
        "dialogue_relation": dialogue.relation.value, "actions": actions,
        "compiled_actions": compiled_actions, "escalates": escalates,
    }


def _score_turn(turn: dict, result: dict) -> dict:
    expected_targets = {str(e["target"]) for e in turn["expected"]}
    expected_objectives = {_FORM_TO_OBJECTIVE.get(e["form"], "other") for e in turn["expected"]}
    expected_final_answers = {_RELEASE_TO_FINAL_ANSWER.get(e["release"], "unspecified") for e in turn["expected"]}

    resolved_targets = {a["target"] for a in result["actions"]}
    resolved_objectives = {a["objective"] for a in result["actions"]}
    # Effective (post-compile_policy) final_answer -- see _run_turn's own
    # comment for why the raw pre-compile value alone understates it.
    resolved_final_answers = {a["final_answer"] for a in result["compiled_actions"]}

    target_match = bool(expected_targets & resolved_targets)
    # Objective/final_answer only scored when the target actually resolved
    # to something comparable -- scoring them on a target miss would
    # double-count the same failure.
    objective_match = target_match and bool(expected_objectives & resolved_objectives)
    final_answer_match = target_match and bool(expected_final_answers & resolved_final_answers)
    all_match = target_match and objective_match and final_answer_match
    return {
        "target_match": target_match, "objective_match": objective_match,
        "final_answer_match": final_answer_match, "all_match": all_match,
        "expected_targets": sorted(expected_targets), "resolved_targets": sorted(resolved_targets),
        "expected_objectives": sorted(expected_objectives), "resolved_objectives": sorted(resolved_objectives),
        "expected_final_answers": sorted(expected_final_answers),
        "resolved_final_answers": sorted(resolved_final_answers),
    }


def main() -> None:
    results = []
    category_totals: dict[str, dict[str, int]] = {}
    overall = {"turns": 0, "target_match": 0, "objective_match": 0, "final_answer_match": 0, "all_match": 0}
    latencies_ms: list[float] = []

    for scenario in CORPUS["cases"]:
        document = DOCUMENTS[scenario["document"]]
        category = scenario["category"]
        category_totals.setdefault(category, {"turns": 0, "all_match": 0})
        for turn_index, turn in enumerate(scenario["turns"]):
            # Gold-independent, shared across every eval arm -- see
            # scripts/semantic_blind_ab_transcript.py's module docstring for
            # the leak this replaces (that module never reads this turn's
            # own `expected`/`verifiedAnswer`, only (form, release) pairs
            # from turns STRICTLY BEFORE this one).
            previous_turns = build_history_turns(scenario, turn_index)
            started = time.perf_counter()
            try:
                result = _run_turn(turn["student"], previous_turns=previous_turns, document=document)
                error = None
            except Exception as exc:  # noqa: BLE001 -- a crash is itself a failure datum, not a harness bug to hide
                result = {"dialogue_relation": None, "actions": [], "compiled_actions": [], "escalates": False}
                error = f"{type(exc).__name__}: {exc}"
            elapsed_ms = (time.perf_counter() - started) * 1000
            latencies_ms.append(elapsed_ms)

            score = _score_turn(turn, result)
            record = {
                "scenario": scenario["id"], "category": category, "language": scenario["language"],
                "turn": turn["n"], "student": turn["student"], "expected": turn["expected"],
                "resolved": result, "score": score, "latency_ms": round(elapsed_ms, 3), "error": error,
            }
            results.append(record)

            overall["turns"] += 1
            category_totals[category]["turns"] += 1
            for key in ("target_match", "objective_match", "final_answer_match", "all_match"):
                if score[key]:
                    overall[key] += 1
            if score["all_match"]:
                category_totals[category]["all_match"] += 1
            else:
                overall.setdefault("wrong_turns", 0)
                overall["wrong_turns"] += 1
                if result["escalates"]:
                    overall.setdefault("wrong_turns_that_would_escalate", 0)
                    overall["wrong_turns_that_would_escalate"] += 1

    latencies_ms.sort()
    p50 = latencies_ms[len(latencies_ms) // 2] if latencies_ms else 0.0
    p95 = latencies_ms[int(len(latencies_ms) * 0.95)] if latencies_ms else 0.0

    summary = {
        "corpus_version": CORPUS.get("corpus_version"), "total_turns": overall["turns"],
        "target_accuracy": round(overall["target_match"] / overall["turns"], 4),
        "objective_accuracy": round(overall["objective_match"] / overall["turns"], 4),
        "final_answer_accuracy": round(overall["final_answer_match"] / overall["turns"], 4),
        "all_fields_accuracy": round(overall["all_match"] / overall["turns"], 4),
        "escalation_trigger_coverage_of_wrong_turns": {
            "wrong_turns": overall.get("wrong_turns", 0),
            "wrong_turns_that_would_escalate": overall.get("wrong_turns_that_would_escalate", 0),
            "fraction": (
                round(overall.get("wrong_turns_that_would_escalate", 0) / overall["wrong_turns"], 4)
                if overall.get("wrong_turns") else None
            ),
        },
        "deterministic_interpretation_latency_ms": {
            "p50": round(p50, 3), "p95": round(p95, 3), "max": round(max(latencies_ms), 3),
        },
        "by_category": {
            cat: {
                "turns": v["turns"], "all_fields_accuracy": round(v["all_match"] / v["turns"], 4),
            }
            for cat, v in sorted(category_totals.items())
        },
    }

    out_path = ROOT / "reports" / "semantic-intent-deterministic-baseline-2026-10-23-fixed-transcript.json"
    out_path.write_text(json.dumps({"summary": summary, "turns": results}, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nFull per-turn results written to {out_path}")


if __name__ == "__main__":
    main()

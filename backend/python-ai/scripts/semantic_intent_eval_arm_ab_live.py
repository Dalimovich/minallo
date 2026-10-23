"""Arm A / Arm B LIVE runner -- real, paid OpenAI calls. NOT RUN as part of
this review; built and ready, pending explicit budget approval for a
specific run (see the written-up report for the exact proposed call counts
and caps). Never run in CI; requires --live outside CI like
run_student_intent_eval.py, whose guard pattern this reuses via
scripts.eval_guarded_transport.

Arm A: today's actual deployed interpretation path on the corpus --
dialogue_state.resolve_dialogue, escalating to the real
resolve_dialogue_semantically ONLY on the ~18/64 turns whose
needs_semantic_resolution gate fires (computed, zero-cost, before this
script was written -- see the 2026-10-23 report). Every other turn makes
no network attempt at all.

Arm B: Milestone 4's authoritative interpreter
(semantic_intent_orchestrator.interpret_turn_authoritatively), called
directly -- this bypasses app/routers/stream.py's three-flag production
gate entirely, which is deliberate: an ISOLATED evaluation of Milestone 4
must not depend on flipping real production settings. ~23/64 turns trigger
its one-call budget (needs_semantic_escalation).

Both arms share the gold-independent transcript
(scripts.semantic_blind_ab_transcript) so their numbers are comparable to
each other and to the zero-cost deterministic baseline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.eval_guarded_transport import BudgetStop, EvalGuardedTransport  # noqa: E402
from scripts.jev_policy_adapter import authorized_labels, load_corpus, load_documents  # noqa: E402
from scripts.semantic_blind_ab_transcript import build_history_turns  # noqa: E402

CORPUS = load_corpus()
DOCUMENTS = load_documents()
USER_ID = "00000000-0000-4000-8000-00000000d001"
CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"

# Same approved request shape as run_student_intent_eval.py's
# GuardedTransport (2026-10-17) -- kept in sync deliberately: both arms'
# classifier calls go through the same chat_completion_params/
# INTERACTIVE_CLASSIFIER_TIMEOUT call shape, just via different entry
# points (resolve_dialogue_semantically vs the unified semantic call).
_APPROVED_FIELDS = {"model", "messages", "max_tokens", "response_format", "temperature", "reasoning_effort"}
_APPROVED_MODELS = {"gpt-4o-mini", "gpt-4o-mini-2024-07-18"}
PRICE_SOURCE = "https://developers.openai.com/api/docs/models/gpt-4o-mini"
# Deliberately generous (full context window + a generous completion
# budget) so the pre-call reservation never underestimates actual spend --
# same reasoning as the original script's PER_ATTEMPT_CEILING.
PER_ATTEMPT_CEILING_USD = (128_000 * 0.15 + 400 * 0.60) / 1_000_000

_RELEASE_TO_FINAL_ANSWER = {
    "permitted": "permitted", "prohibited": "prohibited",
    "partial": "unspecified", "ambiguous_expect_clarify_or_both": "unspecified",
}
_FORM_TO_OBJECTIVE = {
    "hint": "hint", "method_explanation": "explain", "full_solution": "solve",
    "confirmation": "explain", "summary": "summarize",
    "quiz_start": "other", "answer_check": "other",
}


def _validate_and_price(body: dict) -> tuple[float, str]:
    if set(body) - _APPROVED_FIELDS or body.get("model") not in _APPROVED_MODELS:
        raise BudgetStop(f"unapproved request shape or model: {body.get('model')!r}")
    if body.get("response_format") != {"type": "json_object"}:
        raise BudgetStop("unapproved response_format -- classifier calls only")
    return PER_ATTEMPT_CEILING_USD, str(body.get("model"))


def _score(turn: dict, actions: list[dict]) -> dict:
    expected = turn["expected"]
    expected_targets = {str(e["target"]) for e in expected}
    expected_objectives = {_FORM_TO_OBJECTIVE.get(e["form"], "other") for e in expected}
    expected_final_answers = {_RELEASE_TO_FINAL_ANSWER.get(e["release"], "unspecified") for e in expected}
    resolved_targets = {a["target"] for a in actions}
    resolved_objectives = {a["objective"] for a in actions}
    resolved_final_answers = {a["final_answer"] for a in actions}
    target_match = bool(expected_targets & resolved_targets)
    objective_match = target_match and bool(expected_objectives & resolved_objectives)
    final_answer_match = target_match and (
        bool(expected_final_answers & resolved_final_answers) or "unspecified" in expected_final_answers
    )
    return {
        "target_match": target_match, "objective_match": objective_match,
        "final_answer_match": final_answer_match,
        "all_match": target_match and objective_match and final_answer_match,
    }


def _run_arm_a_turn(question: str, *, previous_turns: list[dict]) -> dict:
    from app.services.dialogue_state import needs_semantic_resolution, resolve_dialogue, resolve_dialogue_semantically

    base = resolve_dialogue(question, previous_turns=previous_turns)
    dialogue = base
    escalated = needs_semantic_resolution(question, base, previous_turns)
    if escalated:
        dialogue = resolve_dialogue_semantically(question, previous_turns=previous_turns, base=base)
    return {
        "escalated": escalated,
        "actions": [{
            "target": dialogue.active_question or "current_request",
            "objective": "other", "final_answer": "unspecified",
        }],
        "dialogue_relation": dialogue.relation.value,
    }


def _run_arm_b_turn(question: str, *, previous_turns: list[dict], document: dict) -> dict:
    from app.services.conversation_store import get_durable_conversation_messages, validate_durable_conversation
    from app.services.dialogue_state import resolve_dialogue
    from app.services.semantic_intent_orchestrator import interpret_turn_authoritatively

    base = resolve_dialogue(question, previous_turns=previous_turns)
    result = interpret_turn_authoritatively(
        question=question, dialogue_base=base, preflight_turns=previous_turns,
        user_id=USER_ID, conversation_id=None,
        validate_ownership=validate_durable_conversation, get_messages=get_durable_conversation_messages,
        resolved_access=None, has_visible_context=True,
        authorized_exercise_labels=authorized_labels(document),
    )
    policy = result.execution_policy
    actions = [
        {"target": a.target, "objective": a.objective, "final_answer": a.release.final_answer}
        for a in (policy.actions if policy else [])
    ] or [{"target": "current_request", "objective": "other", "final_answer": "unspecified"}]
    return {
        "escalated": result.resolved_intent is not None,
        "actions": actions,
        "dialogue_relation": result.dialogue.relation.value,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", choices=["a", "b"], required=True)
    parser.add_argument("--live", action="store_true", help="Explicit opt-in to paid calls")
    parser.add_argument("--env-file", type=Path, help="Read only OpenAI key/model from this file")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-requests", type=int, required=True, help="<= number of turns this arm's gate would trigger")
    parser.add_argument("--max-cost-usd", type=float, required=True)
    args = parser.parse_args()
    if not args.live or os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
        parser.error("requires --live outside CI; no automatic runs")
    from dotenv import dotenv_values
    from app.config import Settings
    from app.services import openai_client

    values = dotenv_values(args.env_file) if args.env_file else {}
    model = os.environ.get("OPENAI_GENERATE_MODEL") or values.get("OPENAI_GENERATE_MODEL") or "gpt-4o-mini"
    key = os.environ.get("OPENAI_API_KEY") or values.get("OPENAI_API_KEY")
    if model not in _APPROVED_MODELS or not key:
        parser.error("missing key or model without a reviewed pricing ceiling")
    try:
        settings = Settings(
            _env_file=None, OPENAI_API_KEY=key, OPENAI_GENERATE_MODEL=model,
            SUPABASE_URL="https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY="unused",
            INTERNAL_SECRET="synthetic-unused",
        )
    except ValueError:
        parser.error("invalid local configuration (details withheld to protect credentials)")
    if args.output.exists() or args.output.with_suffix(".md").exists():
        parser.error("output already exists; no reruns/overwrites")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    guard = EvalGuardedTransport(
        args.output.with_suffix(".ledger.jsonl"), httpx.HTTPTransport(retries=0), CHAT_COMPLETIONS_URL,
        _validate_and_price, max_requests=args.max_requests, budget_usd=args.max_cost_usd,
    )
    openai_client.get_openai_client.cache_clear()
    rows: list[dict] = []
    report = {
        "arm": args.arm.upper(), "model": model, "price_source": PRICE_SOURCE,
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "runner_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, cwd=ROOT).strip(),
        "corpus_sha256": hashlib.sha256(
            (ROOT / "tests/fixtures/semantic_blind_ab_corpus.json").read_bytes()
        ).hexdigest(),
        "max_requests": args.max_requests, "max_cost_usd": args.max_cost_usd,
        "worst_case_usd": round(args.max_requests * PER_ATTEMPT_CEILING_USD, 6),
        "cases": rows,
    }
    print(f"Arm {args.arm.upper()}; model {model}; worst-case ${report['worst_case_usd']:.6f}", flush=True)
    try:
        with patch("app.config.get_settings", return_value=settings), \
             patch("app.services.openai_client.get_settings", return_value=settings), \
             patch("app.services.usage_meter.record_usage"):
            client = openai_client.get_openai_client()
            with httpx.Client(transport=guard, follow_redirects=False, trust_env=False) as http:
                instrumented = client.with_options(http_client=http)
                with patch.object(openai_client, "get_openai_client", return_value=instrumented):
                    for scenario in CORPUS["cases"]:
                        document = DOCUMENTS[scenario["document"]]
                        for turn_index, turn in enumerate(scenario["turns"]):
                            previous_turns = build_history_turns(scenario, turn_index)
                            guard.context = {"arm": args.arm.upper(), "scenario": scenario["id"], "turn": turn["n"]}
                            try:
                                if args.arm == "a":
                                    result = _run_arm_a_turn(turn["student"], previous_turns=previous_turns)
                                else:
                                    result = _run_arm_b_turn(
                                        turn["student"], previous_turns=previous_turns, document=document,
                                    )
                                error = None
                            except BudgetStop:
                                raise
                            except Exception as exc:  # noqa: BLE001 -- a crash is itself a failure datum
                                result = {"escalated": None, "actions": [], "dialogue_relation": None}
                                error = f"{type(exc).__name__}: {exc}"
                            score = _score(turn, result["actions"])
                            rows.append({
                                "scenario": scenario["id"], "category": scenario["category"],
                                "turn": turn["n"], "student": turn["student"], "expected": turn["expected"],
                                "result": result, "score": score, "error": error,
                            })
                            args.output.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
                            print(f"{scenario['id']} t{turn['n']}: all_match={score['all_match']} "
                                  f"spent=${guard.spent_usd:.6f}", flush=True)
            client.close()
    except BudgetStop as exc:
        report["stopped"] = str(exc)
    finally:
        report["attempts"] = guard.attempts
        report["total_requests"] = len(guard.attempts)
        report["total_reserved_usd"] = round(guard.spent_usd, 6)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
    print(json.dumps({"total_requests": report["total_requests"], "total_reserved_usd": report["total_reserved_usd"]}, indent=2))


if __name__ == "__main__":
    main()

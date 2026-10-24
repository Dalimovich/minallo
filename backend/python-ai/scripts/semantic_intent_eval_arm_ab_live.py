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
from scripts.fake_conversation_store import FakeConversationStore  # noqa: E402
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


def _run_arm_a_turn(question: str, *, previous_turns: list[dict], document: dict) -> dict:
    """Today's actual deployed interpretation path, reconstructed from the
    real production functions -- NOT a stub. Mirrors semantic_intent_
    deterministic_baseline.py's own method (interpret_student_intent(mode=
    "off") -> diagnostic_policy.adapt_deterministic_intent -> compile_
    policy, the exact same functions production uses on the
    SEMANTIC_INTENT_MODE="off" path) and adds the one real piece that
    script deliberately left out: the legacy resolve_dialogue_
    semantically escalation, which fires in production TODAY on the
    ~18/64 turns whose needs_semantic_resolution gate triggers,
    independent of SEMANTIC_INTENT_MODE entirely (confirmed by reading
    app/routers/stream.py's own call site -- see the 2026-10-23 report).

    Known, stated limitation this does NOT paper over: real production,
    with all three Milestone-4 flags off (today's default), never
    actually calls adapt_deterministic_intent/compile_policy at all --
    release behavior comes from the hardcoded textual instructions
    dialogue_state.py bakes into resolved_request per dialogue_act (e.g.
    "Do not reveal the complete solution or final result" for
    REQUEST_HINT), not a compiled ExecutionPolicy. This function measures
    the deterministic adapter's diagnostic policy as a structured stand-in
    for that textual behavior -- the same interpretation the existing,
    already-reviewed deterministic baseline makes, not a new assumption
    introduced here. A literal text-scan arm (grep resolved_request for
    the real hardcoded phrases) is a different, narrower measurement this
    does not attempt to replace.
    """
    from app.services.dialogue_state import needs_semantic_resolution, resolve_dialogue, resolve_dialogue_semantically
    from app.services.diagnostic_policy import adapt_deterministic_intent
    from app.services.policy_compiler import compile_policy
    from app.services.student_intent import interpret_student_intent

    base = resolve_dialogue(question, previous_turns=previous_turns)
    dialogue = base
    escalated = needs_semantic_resolution(question, base, previous_turns)
    if escalated:
        dialogue = resolve_dialogue_semantically(question, previous_turns=previous_turns, base=base)

    student_intent = interpret_student_intent(
        question, dialogue=dialogue, resolved_access=None, has_visible_context=True,
        mode="off", previous_turns=previous_turns, user_id=USER_ID,
    )
    resolved = adapt_deterministic_intent(
        message=question, dialogue=dialogue, student_intent=student_intent,
        authorized_exercise_labels=authorized_labels(document), has_visible_context=True,
    )
    policy = compile_policy(resolved, turn_ledger=None, conversation_id=None)
    return {
        "escalated": escalated,
        "actions": [
            {"target": a.target, "objective": a.objective, "final_answer": a.release.final_answer}
            for a in policy.actions
        ],
        "dialogue_relation": dialogue.relation.value,
    }


def _run_arm_b_turn(
    question: str, *, previous_turns: list[dict], document: dict,
    store: FakeConversationStore, conversation_id: str, turn_n: int,
) -> dict:
    """Milestone 4's authoritative interpreter, with REAL verified durable
    history -- not conversation_id=None (the 2026-10-24 fix: that made
    every turn history-free and could never exercise the multi-turn
    restriction-persistence mechanism that distinguishes Milestone 4 from
    the legacy path at all). ``store`` is a FakeConversationStore the
    caller created once per SCENARIO (one durable conversation per
    scenario, matching real per-conversation isolation) and must call
    ``store.append_turn(...)`` with this call's real ``execution_policy``
    after this returns, so the NEXT turn in the same scenario can actually
    see it -- this function does not persist its own result; the caller
    owns write timing (see main()'s loop)."""
    from app.services.dialogue_state import resolve_dialogue
    from app.services.semantic_intent_orchestrator import interpret_turn_authoritatively

    base = resolve_dialogue(question, previous_turns=previous_turns)
    result = interpret_turn_authoritatively(
        question=question, dialogue_base=base, preflight_turns=previous_turns,
        user_id=USER_ID, conversation_id=conversation_id,
        validate_ownership=store.validate_ownership, get_messages=store.get_messages,
        resolved_access=None, has_visible_context=True,
        authorized_exercise_labels=authorized_labels(document),
    )
    policy = result.execution_policy
    actions = [
        {"target": a.target, "objective": a.objective, "final_answer": a.release.final_answer}
        for a in (policy.actions if policy else [])
    ] or [{"target": "current_request", "objective": "other", "final_answer": "unspecified"}]
    return {
        "escalated": result.used_unified_call,
        "actions": actions,
        "dialogue_relation": result.dialogue.relation.value,
        "execution_policy": policy,
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
                    store = FakeConversationStore()
                    for scenario in CORPUS["cases"]:
                        document = DOCUMENTS[scenario["document"]]
                        # One real, durable conversation per SCENARIO (never per
                        # turn) -- matches real per-conversation isolation, and
                        # is what actually lets turn 2+ of a scenario see turn
                        # 1's persisted restriction via the real mechanism.
                        conversation_id = store.create_conversation(user_id=USER_ID)
                        for turn_index, turn in enumerate(scenario["turns"]):
                            previous_turns = build_history_turns(scenario, turn_index)
                            guard.context = {"arm": args.arm.upper(), "scenario": scenario["id"], "turn": turn["n"]}
                            try:
                                if args.arm == "a":
                                    result = _run_arm_a_turn(
                                        turn["student"], previous_turns=previous_turns, document=document,
                                    )
                                else:
                                    result = _run_arm_b_turn(
                                        turn["student"], previous_turns=previous_turns, document=document,
                                        store=store, conversation_id=conversation_id, turn_n=turn["n"],
                                    )
                                    policy_obj = result.pop("execution_policy", None)
                                    if policy_obj is not None:
                                        store.append_turn(
                                            conversation_id=conversation_id, turn_n=turn["n"],
                                            execution_policy=policy_obj,
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

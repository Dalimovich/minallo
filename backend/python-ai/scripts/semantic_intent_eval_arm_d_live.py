"""Arm D LIVE runner -- Jev-assisted interpretation with MANDATORY
escalation to Milestone 4 (Arm B), structural or confidence-based.

2026-10-24 correction: the escalation decision previously read
``gold_form``/benchmark ``category`` directly -- a deployed system would
never have those labels at inference time. Rewritten to use ONLY
information a real request actually carries: the student's message,
verified conversation state (``dialogue.relation``, computed by the real,
deterministic ``resolve_dialogue`` -- no model call, no gold), Jev's own
returned ``objective``/confidences, and ``target_unverified`` (computed by
grounding Jev's claimed target against the document's REAL authorized
exercise labels via ``diagnostic_policy.resolve_target_identity`` -- a
structural check against trusted context, not a benchmark label, and
legitimate at inference time for exactly that reason).

NOT RUNNABLE YET: this arm consumes a real Jev report in
jev_corpus_evaluation.py's exact per-turn shape (``jev_result`` with
``target``/``objective``/``target_confidence``/``objective_confidence``),
collected against the SAME gold-independent transcript Arms A/B use
(scripts.semantic_blind_ab_transcript) -- the existing 2026-10-22 Jev
report does not qualify (no assistant turns in its context at all) and no
qualifying report exists yet. ``main()`` still requires --live and a real
Jev report path, and now shares Arm A/B's EvalGuardedTransport durable
ledger for every escalated call (2026-10-24 addition: this arm previously
called Arm B with no spending guard at all).

Escalation rule ("mandatory structural AND confidence-based", not
confidence alone):

- MANDATORY, always escalate regardless of confidence:
  - ``target_unverified`` -- Jev's claimed target does not ground against
    the document's real exercise labels or the literal message text.
  - Jev's own ``objective == "other"`` -- Jev itself could not pick a
    specific category; its own output IS the ambiguity signal, no gold
    needed to know its vocabulary has no better fit here.
  - ``dialogue.relation`` is history-dependent (CONTINUATION, CORRECTION,
    REJECTION, or CONFIRMATION) AND there is prior conversation history --
    Jev's 3-question schema has no persisted-restriction concept at all,
    so any turn whose correct handling depends on an earlier turn's
    restriction state needs the real, ledger-aware Milestone 4 path.
- CONFIDENCE-based: Jev's own ``target_confidence``/``objective_confidence``
  falls below ``CONFIDENCE_THRESHOLD``.

CONFIDENCE_THRESHOLD has no default -- it must be chosen on a DEVELOPMENT
split of the corpus once real Jev confidence data exists, then evaluated
once, unchanged, against tests/fixtures/semantic_blind_ab_holdout.json --
never tuned against the holdout itself.
"""

from __future__ import annotations

import argparse
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
from scripts.jev_policy_adapter import load_corpus, load_documents, rescore_jev_answer  # noqa: E402
from scripts.semantic_blind_ab_transcript import build_history_turns  # noqa: E402
from scripts.semantic_intent_eval_arm_ab_live import (  # noqa: E402
    CHAT_COMPLETIONS_URL, PER_ATTEMPT_CEILING_USD, PRICE_SOURCE, USER_ID,
    _APPROVED_MODELS, _validate_and_price, _run_arm_b_turn,
)

CORPUS = load_corpus()
DOCUMENTS = load_documents()
_SCENARIO_BY_ID = {c["id"]: c for c in CORPUS["cases"]}

# Jev's own output IS the ambiguity signal here -- no gold needed. See
# module docstring.
_AMBIGUOUS_JEV_OBJECTIVE = "other"
# Mirrors dialogue_state.TurnRelation's own names -- a real, deterministic,
# zero-model-call classification already computed by resolve_dialogue for
# every turn, never a benchmark label.
_HISTORY_DEPENDENT_RELATIONS = frozenset({"continuation", "correction", "rejection", "confirmation"})


def should_escalate_to_milestone4(
    *, jev_objective: str, target_unverified: bool, dialogue_relation: str, has_prior_turns: bool,
    target_confidence: float | None, objective_confidence: float | None, confidence_threshold: float,
) -> tuple[bool, str]:
    """Returns (escalate, reason). Mandatory reasons are checked first and
    never overridden by a high confidence score. Every argument is
    something a real deployed system actually has at inference time --
    see module docstring for why each one qualifies."""
    if target_unverified:
        return True, "mandatory:target_unverified"
    if jev_objective == _AMBIGUOUS_JEV_OBJECTIVE:
        return True, "mandatory:jev_objective_ambiguous"
    if has_prior_turns and dialogue_relation in _HISTORY_DEPENDENT_RELATIONS:
        return True, f"mandatory:history_dependent_relation:{dialogue_relation}"
    confidences = [c for c in (target_confidence, objective_confidence) if c is not None]
    lowest = min(confidences) if confidences else 0.0
    if lowest < confidence_threshold:
        return True, f"confidence:{lowest:.2f}<{confidence_threshold:.2f}"
    return False, "jev_sufficient"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--env-file", type=Path, help="Read only OpenAI key/model from this file")
    parser.add_argument(
        "--jev-report", type=Path, required=True,
        help="A real Jev corpus report collected against the shared transcript -- does not exist yet.",
    )
    parser.add_argument(
        "--confidence-threshold", type=float, required=True,
        help="Chosen on a DEV split, never on the holdout -- no default provided deliberately.",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--max-requests", type=int, required=True,
        help="<= the number of turns this run's mandatory+confidence gate would actually escalate",
    )
    parser.add_argument("--max-cost-usd", type=float, required=True)
    args = parser.parse_args()
    if not args.live or os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
        parser.error("requires --live outside CI; this is a real-spend arm (escalated turns call Arm B for real)")
    if not args.jev_report.exists():
        parser.error(
            f"{args.jev_report} does not exist -- Arm D needs a real Jev report collected against "
            "scripts.semantic_blind_ab_transcript's shared history first (its own approved run)"
        )
    if args.output.exists() or args.output.with_suffix(".md").exists():
        parser.error("output already exists; no reruns/overwrites")

    from app.services.dialogue_state import resolve_dialogue
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
    args.output.parent.mkdir(parents=True, exist_ok=True)

    guard = EvalGuardedTransport(
        args.output.with_suffix(".ledger.jsonl"), httpx.HTTPTransport(retries=0), CHAT_COMPLETIONS_URL,
        _validate_and_price, max_requests=args.max_requests, budget_usd=args.max_cost_usd,
    )
    openai_client.get_openai_client.cache_clear()

    jev_report = json.loads(args.jev_report.read_text(encoding="utf-8"))
    rows: list[dict] = []
    report = {
        "arm": "D", "model": model, "price_source": PRICE_SOURCE,
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "runner_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, cwd=ROOT).strip(),
        "jev_report_path": str(args.jev_report), "confidence_threshold": args.confidence_threshold,
        "max_requests": args.max_requests, "max_cost_usd": args.max_cost_usd,
        "worst_case_usd": round(args.max_requests * PER_ATTEMPT_CEILING_USD, 6),
        "rows": rows,
    }
    try:
        with patch("app.config.get_settings", return_value=settings), \
             patch("app.services.openai_client.get_settings", return_value=settings), \
             patch("app.services.usage_meter.record_usage"):
            client = openai_client.get_openai_client()
            with httpx.Client(transport=guard, follow_redirects=False, trust_env=False) as http:
                instrumented = client.with_options(http_client=http)
                with patch.object(openai_client, "get_openai_client", return_value=instrumented):
                    store = FakeConversationStore()
                    conversation_id_by_scenario: dict[str, str] = {}
                    for jev_turn in jev_report["turns"]:
                        scenario = _SCENARIO_BY_ID[jev_turn["scenario"]]
                        document = DOCUMENTS[scenario["document"]]
                        turn_index = jev_turn["turn"] - 1
                        turn = scenario["turns"][turn_index]
                        previous_turns = build_history_turns(scenario, turn_index)

                        dialogue = resolve_dialogue(turn["student"], previous_turns=previous_turns)
                        rescored = rescore_jev_answer(
                            jev_target=jev_turn["jev_result"]["target"],
                            jev_objective=jev_turn["jev_result"]["objective"],
                            message=turn["student"], document=document,
                        )
                        escalate, reason = should_escalate_to_milestone4(
                            jev_objective=jev_turn["jev_result"]["objective"],
                            target_unverified=rescored.target_unverified,
                            dialogue_relation=dialogue.relation.value, has_prior_turns=bool(previous_turns),
                            target_confidence=jev_turn["jev_result"].get("target_confidence"),
                            objective_confidence=jev_turn["jev_result"].get("objective_confidence"),
                            confidence_threshold=args.confidence_threshold,
                        )
                        error = None
                        if escalate:
                            conversation_id = conversation_id_by_scenario.setdefault(
                                scenario["id"], store.create_conversation(user_id=USER_ID),
                            )
                            guard.context = {"arm": "D", "scenario": scenario["id"], "turn": turn["n"]}
                            try:
                                b_result = _run_arm_b_turn(
                                    turn["student"], previous_turns=previous_turns, document=document,
                                    store=store, conversation_id=conversation_id, turn_n=turn["n"],
                                )
                                policy_obj = b_result.pop("execution_policy", None)
                                if policy_obj is not None:
                                    store.append_turn(
                                        conversation_id=conversation_id, turn_n=turn["n"], execution_policy=policy_obj,
                                    )
                                actions = b_result["actions"]
                            except BudgetStop:
                                raise
                            except Exception as exc:  # noqa: BLE001 -- a crash is itself a failure datum
                                actions = []
                                error = f"{type(exc).__name__}: {exc}"
                        else:
                            actions = [{
                                "target": jev_turn["jev_result"]["target"],
                                "objective": jev_turn["jev_result"]["objective"],
                                "final_answer": rescored.compiled_final_answer,
                            }]
                        rows.append({
                            "scenario": scenario["id"], "turn": turn["n"],
                            "escalated": escalate, "escalation_reason": reason,
                            "actions": actions, "error": error,
                        })
                        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
            client.close()
    except BudgetStop as exc:
        report["stopped"] = str(exc)
    finally:
        report["attempts"] = guard.attempts
        report["total_requests"] = len(guard.attempts)
        report["total_reserved_usd"] = round(guard.spent_usd, 6)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
    print(f"{sum(r['escalated'] for r in rows)}/{len(rows)} turns escalated to Arm B.")
    print(json.dumps({"total_requests": report["total_requests"], "total_reserved_usd": report["total_reserved_usd"]}, indent=2))


if __name__ == "__main__":
    main()

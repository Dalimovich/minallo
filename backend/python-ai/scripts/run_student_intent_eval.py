"""Opt-in synthetic evaluation of the production interpreter. Never run in CI.

Run from backend/python-ai: python -m scripts.run_student_intent_eval --help
The model is called once per non-injected case, including cases the production
gate skips. The SAME result is replayed through the gate and router offline.
No alternate classifier, prompt, schema or validation is implemented here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import subprocess
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

# Official model/pricing page checked 2026-10-17. Unknown models fail closed.
PRICE_SOURCE = "https://developers.openai.com/api/docs/models/gpt-4o-mini"
PER_ATTEMPT_CEILING = (128_000 * 0.15 + 180 * 0.60) / 1_000_000
ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "tests/fixtures/student_intent_eval_cases.json"


class BudgetStop(BaseException):
    """Must bypass SDK retries AND production's Exception fallback boundary."""


class GuardedTransport(httpx.BaseTransport):
    """Count and durably reserve every HTTP attempt, including SDK retries.

    Reservations are never refunded, even for errors/timeouts. The full context
    window bound avoids relying on approximate tokenizer counts for budgeting.
    An existing ledger refuses a second run (including after interruption).
    """

    def __init__(self, ledger, inner, *, max_requests=40, budget=5.0):
        if not 0 < max_requests <= 40 or not 0 < budget <= 5:
            raise ValueError("limits must be positive and within 40 requests / $5")
        self.ledger = Path(ledger)
        self.ledger.touch(exist_ok=False)
        self.inner = inner
        self.max_requests = max_requests
        self.budget = budget
        self.attempts: list[dict] = []
        self.case_id = ""

    def handle_request(self, request):
        body = json.loads(request.content)
        allowed = {"model", "messages", "max_tokens", "response_format"}
        if (str(request.url) != "https://api.openai.com/v1/chat/completions"
                or request.method != "POST" or set(body) - allowed
                or body.get("model") not in {"gpt-4o-mini", "gpt-4o-mini-2024-07-18"}
                or body.get("max_tokens") != 180
                or body.get("response_format") != {"type": "json_object"}):
            raise BudgetStop("unapproved endpoint, model, or request shape")
        if (len(self.attempts) >= self.max_requests
                or (len(self.attempts) + 1) * PER_ATTEMPT_CEILING > self.budget):
            raise BudgetStop("pre-call request/cost ceiling reached")
        attempt = {"case": self.case_id, "number": len(self.attempts) + 1,
                   "reserved_usd": PER_ATTEMPT_CEILING,
                   "sdk_retry": int(request.headers.get("x-stainless-retry-count", "0"))}
        with self.ledger.open("a", encoding="utf-8") as out:
            out.write(json.dumps(attempt) + "\n")
            out.flush()
            os.fsync(out.fileno())
        self.attempts.append(attempt)
        started = time.perf_counter()
        try:
            response = self.inner.handle_request(request)
            response.read()
            attempt["status"] = response.status_code
            if response.status_code == 200:
                data = response.json()
                attempt["usage"] = data.get("usage")
                attempt["returned_model"] = data.get("model")
                attempt["choices"] = data.get("choices", [])
            return response
        except Exception as exc:
            attempt["error"] = type(exc).__name__  # never log request/headers/credentials
            raise
        finally:
            attempt["latency_ms"] = (time.perf_counter() - started) * 1000

    def close(self):
        self.inner.close()


def snapshot(intent):
    return json.loads(json.dumps(asdict(intent)))


def expected(case):
    # Additional human-authored labels fixed BEFORE live calls; the existing
    # primary/prohibition/clarification labels remain unchanged, even if flawed.
    depths = {
        "historical-bwl-page6": "detailed", "german-negative-instruction": "detailed",
        "positive-summary-request": "brief", "summarize-task": "brief",
        "mixed-language-code-switch": "brief", "timeout": "brief",
        "follow-up-why": "brief", "hint-request": "one_step",
    }
    return {"primary_task": case["expectedPrimaryTask"],
            "prohibited_tasks": case["expectedProhibitedTasks"],
            "depth": depths.get(case["id"], "normal"),
            "visual_requirement": case["id"] == "diagram-reference",
            "needs_clarification": case["expectedNeedsClarification"],
            "scope": case["resolvedAccess"]}


def score(actual, labels):
    if actual is None:
        return {key: False for key in labels}
    return {key: (set(actual[key]) == set(value) if key == "prohibited_tasks"
                  else actual[key] == value) for key, value in labels.items()}


def aggregate(rows, lane):
    selected = [r for r in rows if not r["injected_failure"]]
    if not selected:
        return {}
    metrics = {key + "_accuracy": sum(r[lane + "_score"][key] for r in selected)
               / len(selected) for key in selected[0][lane + "_score"]}
    tp = fp = fn = 0
    for row in selected:
        target = set(row["expected"]["prohibited_tasks"])
        found = set((row[lane] or {}).get("prohibited_tasks", []))
        tp += len(target & found)
        fp += len(found - target)
        fn += len(target - found)
    metrics.update(n=len(selected), prohibition_recall=tp / (tp + fn) if tp + fn else None,
                   prohibition_precision=tp / (tp + fp) if tp + fp else None,
                   all_fields_pass=sum(all(r[lane + "_score"].values()) for r in selected))
    return metrics


def evaluate_case(case, guard):
    from app.services import student_intent as si
    from app.services.dialogue_state import resolve_dialogue
    from app.services.execution_router import resolve_execution_plan
    from app.services.grounding_contract import ResolvedDocumentAccess

    turns = case.get("previousTurns") or []
    dialogue = resolve_dialogue(case["message"], previous_turns=turns)
    access = ResolvedDocumentAccess(case["resolvedAccess"])
    args = dict(dialogue=dialogue, resolved_access=access, previous_turns=turns,
                has_visible_context=case.get("hasVisibleContext", False))
    base = si.interpret_student_intent(case["message"], mode="off", **args)
    escalates = si._needs_semantic_path(case["message"], dialogue)
    injected = case.get("simulateModelFailure")
    semantic = None
    error = None
    guard.case_id = case["id"]
    before = len(guard.attempts)
    started = time.perf_counter()
    if not injected:
        try:
            semantic = si._semantic_model_call(
                message=case["message"], dialogue=dialogue, previous_turns=turns,
                base=base, user_id=None)
        except Exception as exc:
            error = type(exc).__name__
    latency = (time.perf_counter() - started) * 1000

    def replay(**kwargs):
        if injected == "timeout":
            raise TimeoutError("synthetic timeout")
        if injected == "malformed" or error:
            raise ValueError("recorded failure")
        return semantic

    with patch.object(si, "_semantic_model_call", side_effect=replay):
        effective = si.interpret_student_intent(case["message"], mode="enabled", **args)
        shadow = si.interpret_student_intent(case["message"], mode="shadow", **args)
    plans = {}
    for mode, intent in (("off", None), ("shadow", shadow), ("enabled", effective)):
        _, plan = resolve_execution_plan(
            question=dialogue.resolved_request, resolved_access=access,
            processing_pipeline="relevance", resolved_turn=dialogue,
            student_intent=si.intent_for_router(mode, intent))
        plans[mode] = plan.to_api()
    labels = expected(case)
    model = snapshot(semantic) if semantic else None
    actual = snapshot(effective)
    baseline = snapshot(base)
    attempts = guard.attempts[before:]
    checks = {"shadow_payload_unchanged": plans["off"] == plans["shadow"],
              "enabled_plan_only_adds_signal": {**plans["enabled"], "signals": plans["off"]["signals"]}
                  == plans["off"],
              "enabled_signal_present": "semantic_intent_available" in plans["enabled"]["signals"],
              "explicit_prohibitions_preserved": set(base.prohibited_tasks) <= set(effective.prohibited_tasks),
              "trusted_fields_preserved": all(actual[k] == baseline[k] for k in
                  ("scope", "references_resolved", "references_unresolved", "student_goal", "original_message"))}
    causes = []
    model_score, effective_score = score(model, labels), score(actual, labels)
    if not injected:
        if error:
            causes.append("invalid structured output" if error in {"ValueError", "JSONDecodeError"}
                          else "timeout or API error")
        elif semantic is None:
            causes.append("confidence threshold rejected result (correctness requires raw review)")
        elif not all(model_score.values()):
            causes.append("incorrect semantic interpretation or evaluation fixture issue; review fields")
        if not all(effective_score.values()) and not escalates:
            causes.append("escalation heuristic did not trigger")
    if not checks["explicit_prohibitions_preserved"]:
        causes.append("deterministic/semantic merge lost information")
    if case.get("knownGap"):
        causes.append("documented known gap remains; fixture labels encode baseline behavior")
    return {"id": case["id"], "message": case["message"], "known_gap": bool(case.get("knownGap")),
            "injected_failure": injected, "expected": labels, "baseline": baseline,
            "model": model, "effective": actual, "expected_escalates": case["expectedEscalates"],
            "escalates": escalates, "model_score": model_score, "effective_score": effective_score,
            "integration": checks, "plans": plans, "latency_ms": latency, "attempts": attempts,
            "prompt_tokens": sum((a.get("usage") or {}).get("prompt_tokens", 0) for a in attempts),
            "completion_tokens": sum((a.get("usage") or {}).get("completion_tokens", 0) for a in attempts),
            "estimated_usd": sum(((a.get("usage") or {}).get("prompt_tokens", 0) * .15
                + (a.get("usage") or {}).get("completion_tokens", 0) * .60) / 1_000_000 for a in attempts),
            "error": error, "failure_causes": causes,
            "pass": all(effective_score.values()) and all(checks.values()) and not case.get("knownGap", False)}


def totals(rows, attempts):
    live = [r for r in rows if not r["injected_failure"]]
    latency = sorted(r["latency_ms"] for r in live)
    prompt = sum((a.get("usage") or {}).get("prompt_tokens", 0) for a in attempts)
    completion = sum((a.get("usage") or {}).get("completion_tokens", 0) for a in attempts)
    unknown = sum(not a.get("usage") for a in attempts)
    return {"model": aggregate(rows, "model"), "effective": aggregate(rows, "effective"),
            "http_attempts": len(attempts), "sdk_retries": sum(a["sdk_retry"] > 0 for a in attempts),
            "model_invocations": len(live), "prompt_tokens": prompt, "completion_tokens": completion,
            "unknown_usage_attempts": unknown,
            "estimated_usd": (prompt * .15 + completion * .60) / 1_000_000,
            "conservative_usd_including_unknown": (prompt * .15 + completion * .60) / 1_000_000
                + unknown * PER_ATTEMPT_CEILING,
            "reserved_usd": len(attempts) * PER_ATTEMPT_CEILING,
            "latency_mean_ms": statistics.mean(latency) if latency else None,
            "latency_median_ms": statistics.median(latency) if latency else None,
            "latency_p95_ms": latency[math.ceil(.95 * len(latency)) - 1] if latency else None,
            "structured_output_rate": sum(r["model"] is not None or (r["error"] is None and
                bool(r["attempts"])) for r in live) / len(live) if live else None,
            "escalation_frequency": sum(r["escalates"] for r in live) / len(live) if live else None,
            "fallback_rate": sum(r["effective"]["interpretation_source"] == "fallback"
                                 for r in live) / len(live) if live else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Explicit opt-in to paid calls")
    parser.add_argument("--env-file", type=Path, help="Read only OpenAI key/model from this file")
    parser.add_argument("--output", type=Path, default=ROOT / "student-intent-eval.json")
    args = parser.parse_args()
    if not args.live or os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
        parser.error("requires --live outside CI; no automatic runs")
    from dotenv import dotenv_values
    from app.config import Settings
    from app.services import openai_client
    values = dotenv_values(args.env_file) if args.env_file else {}
    model = os.environ.get("OPENAI_GENERATE_MODEL") or values.get("OPENAI_GENERATE_MODEL") or "gpt-4o-mini"
    key = os.environ.get("OPENAI_API_KEY") or values.get("OPENAI_API_KEY")
    if model not in {"gpt-4o-mini", "gpt-4o-mini-2024-07-18"} or not key:
        parser.error("missing key or model without reviewed pricing ceiling")
    settings = Settings(_env_file=None, OPENAI_API_KEY=key, OPENAI_GENERATE_MODEL=model,
                        SUPABASE_URL="https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY="unused",
                        INTERNAL_SECRET="synthetic-unused")
    if args.output.exists() or args.output.with_suffix(".md").exists():
        parser.error("output already exists; no reruns/overwrites")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    guard = GuardedTransport(args.output.with_suffix(".ledger.jsonl"), httpx.HTTPTransport(retries=0))
    # Use the production factory and SDK; only its HTTP transport is instrumented.
    openai_client.get_openai_client.cache_clear()
    rows = []
    report = {"model": model, "price_source": PRICE_SOURCE, "price_checked": "2026-10-17",
              "started_utc": datetime.now(timezone.utc).isoformat(),
              "implementation_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
              "corpus_sha256": hashlib.sha256(CORPUS.read_bytes()).hexdigest(),
              "max_requests": 40, "budget_usd": 5, "worst_case_usd": 40 * PER_ATTEMPT_CEILING,
              "method": "one direct production model call; offline replay through unchanged production gate/router",
              "cases": rows}
    print(f"Model {model}; 40-attempt ceiling ${40 * PER_ATTEMPT_CEILING:.6f}", flush=True)
    try:
        with patch("app.config.get_settings", return_value=settings), patch(
            "app.services.openai_client.get_settings", return_value=settings
        ), patch("app.services.usage_meter.record_usage"):
            client = openai_client.get_openai_client()
            with httpx.Client(transport=guard, follow_redirects=False, trust_env=False) as http:
                instrumented = client.with_options(http_client=http)
                with patch.object(openai_client, "get_openai_client", return_value=instrumented):
                    for case in json.loads(CORPUS.read_text(encoding="utf-8"))["cases"]:
                        rows.append(evaluate_case(case, guard))
                        report["totals"] = totals(rows, guard.attempts)
                        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                        print(f"{case['id']}: {rows[-1]['effective']['interpretation_source']}", flush=True)
            client.close()
    except BudgetStop as exc:
        report["stopped"] = str(exc)
    finally:
        report["attempts"] = guard.attempts
        report["totals"] = totals(rows, guard.attempts)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        summary = ["# Student intent evaluation", "", "Initial diagnostic sample, not production accuracy proof.",
                   "Model lane invokes production classification directly. Effective lane replays through its gate.",
                   "Injected failures excluded from accuracy/latency totals. Known gaps reported as failures.",
                   "", "```json", json.dumps(report["totals"], indent=2), "```", "",
                   "| Case | Effective source | Result | Mismatched fields |", "|---|---|---|---|"]
        for row in rows:
            mismatch = ", ".join(k for k, ok in row["effective_score"].items() if not ok)
            summary.append(f"| {row['id']} | {row['effective']['interpretation_source']} | "
                           f"{'PASS' if row['pass'] else 'FAIL'} | {mismatch} |")
        args.output.with_suffix(".md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(json.dumps(report["totals"], indent=2))


if __name__ == "__main__":
    main()

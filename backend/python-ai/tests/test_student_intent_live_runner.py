"""Offline safety checks; these tests must never use a real API key."""
import json
import importlib.util
from pathlib import Path

import httpx
import pytest

_spec = importlib.util.spec_from_file_location(
    "intent_eval_runner", Path(__file__).parents[1] / "scripts/run_student_intent_eval.py")
assert _spec and _spec.loader
_runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_runner)
BudgetStop, GuardedTransport = _runner.BudgetStop, _runner.GuardedTransport


def request(**overrides):
    body = {"model": "gpt-4o-mini", "max_tokens": 180,
            "response_format": {"type": "json_object"}, "messages": []}
    body.update(overrides)
    return httpx.Request("POST", "https://api.openai.com/v1/chat/completions", json=body)


def test_each_attempt_reserved_before_send_and_cap_blocks_retry(tmp_path):
    sent = []
    ledger = tmp_path / "ledger.jsonl"

    def respond(req):
        assert ledger.read_text().count("\n") == len(sent) + 1
        sent.append(req)
        return httpx.Response(500, json={"error": "synthetic"})

    guard = GuardedTransport(ledger, httpx.MockTransport(respond), max_requests=2)
    for _ in range(2):
        guard.handle_request(request())
    with pytest.raises(BudgetStop):
        guard.handle_request(request())
    assert len(sent) == 2


@pytest.mark.parametrize("override", [
    {"model": "gpt-4o"}, {"max_tokens": 181}, {"stream": True},
    {"tools": [{}]}, {"max_completion_tokens": 12000},
])
def test_unapproved_request_never_sent(tmp_path, override):
    guard = GuardedTransport(tmp_path / "ledger", httpx.MockTransport(
        lambda _: pytest.fail("network must not be reached")))
    with pytest.raises(BudgetStop):
        guard.handle_request(request(**override))


def test_cost_cap_and_restart_fail_closed(tmp_path):
    path = tmp_path / "ledger"
    guard = GuardedTransport(path, httpx.MockTransport(lambda _: pytest.fail()), budget=0.001)
    with pytest.raises(BudgetStop):
        guard.handle_request(request())
    path.write_text(json.dumps({"reserved": True}) + "\n")
    with pytest.raises(FileExistsError):
        GuardedTransport(path, httpx.MockTransport(lambda _: pytest.fail()))


def test_sdk_retry_is_counted_and_budget_stop_not_swallowed(tmp_path):
    from openai import OpenAI

    guard = GuardedTransport(tmp_path / "ledger", httpx.MockTransport(
        lambda _: httpx.Response(500, json={"error": {"message": "synthetic"}})),
        max_requests=1)
    with httpx.Client(transport=guard) as http:
        client = OpenAI(api_key="synthetic", http_client=http, max_retries=1)
        with pytest.raises(BudgetStop):
            client.chat.completions.create(model="gpt-4o-mini", messages=[],
                max_tokens=180, response_format={"type": "json_object"})
    assert len(guard.attempts) == 1


def test_entire_corpus_offline_replay_and_detect_prohibition_loss(tmp_path, monkeypatch):
    from app.services import openai_client
    from openai import OpenAI

    def response(req):
        # Intentionally omit every prohibition: the evaluation must expose
        # production's overwrite rather than silently treating it as safe.
        data = {"primaryTask": "conceptual_explanation", "prohibitedTasks": [],
                "depth": "detailed", "teachingStyle": "default",
                "visualRequirement": False, "confidence": 0.9}
        return httpx.Response(200, json={"id": "synthetic", "object": "chat.completion",
            "created": 1, "model": "gpt-4o-mini", "choices": [{"index": 0,
                "message": {"role": "assistant", "content": json.dumps(data)},
                "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 800, "completion_tokens": 60, "total_tokens": 860}})

    guard = GuardedTransport(tmp_path / "ledger", httpx.MockTransport(response))
    monkeypatch.setattr("app.services.usage_meter.record_usage", lambda **kw: None)
    with httpx.Client(transport=guard) as http:
        client = OpenAI(api_key="synthetic", http_client=http)
        monkeypatch.setattr(openai_client, "get_openai_client", lambda: client)
        cases = json.loads(_runner.CORPUS.read_text(encoding="utf-8"))["cases"]
        rows = [_runner.evaluate_case(case, guard) for case in cases]
    assert len(rows) == 23
    assert len(guard.attempts) == 21
    # Verify the measurement, not continued existence of the production bug:
    # a later union-merge fix must not require weakening this test.
    preserved = set(rows[0]["baseline"]["prohibited_tasks"]) <= set(
        rows[0]["effective"]["prohibited_tasks"])
    assert rows[0]["integration"]["explicit_prohibitions_preserved"] == preserved
    assert "course_summary" in rows[0]["baseline"]["prohibited_tasks"]
    assert json.loads(guard.attempts[0]["choices"][0]["message"]["content"])["prohibitedTasks"] == []
    assert all(r["integration"]["shadow_payload_unchanged"] for r in rows)
    assert all(r["integration"]["trusted_fields_preserved"] for r in rows)
    assert sum(r["effective"]["interpretation_source"] == "fallback" for r in rows) == 2


def test_omitted_prohibition_is_a_scoring_failure():
    assert _runner.score({"prohibited_tasks": []}, {"prohibited_tasks": ["course_summary"]}) == {
        "prohibited_tasks": False}

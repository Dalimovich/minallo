from types import SimpleNamespace

import pytest

from app.services import gen_timing, llm_json


def _patch(monkeypatch):
    seen = {}

    class Completions:
        def create(self, **kwargs):
            seen.update(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))],
                usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
            )

    client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    client.with_options = lambda **kw: (seen.setdefault("client_options", kw), client)[1]
    monkeypatch.setattr(llm_json, "get_openai_client", lambda: client)
    monkeypatch.setattr(llm_json, "record_usage", lambda **kw: None)
    monkeypatch.setattr(llm_json, "usage_from_response", lambda resp: {})
    return seen


def test_call_gets_remaining_budget_as_timeout(monkeypatch):
    seen = _patch(monkeypatch)
    with gen_timing.timed_request("reading", "lesen_1", budget_s=30):
        llm_json.chat_json(system="s", user="u")
    assert 0 < seen["timeout"] <= 30
    # SDK retries would multiply the timeout past the budget, so they are off under a timer.
    assert seen["client_options"] == {"max_retries": 0}


def test_exhausted_budget_stops_further_llm_calls(monkeypatch):
    seen = _patch(monkeypatch)
    with gen_timing.timed_request("reading", "lesen_1", budget_s=0.5) as timer:
        timer.started -= 5  # budget already spent
        with pytest.raises(gen_timing.GenerationBudgetExceeded):
            llm_json.chat_json(system="s", user="u")
    assert "timeout" not in seen
    assert "client_options" not in seen  # untimed callers keep the SDK default retries  # provider never called


def test_no_timer_no_timeout_override(monkeypatch):
    seen = _patch(monkeypatch)
    llm_json.chat_json(system="s", user="u")
    assert "timeout" not in seen

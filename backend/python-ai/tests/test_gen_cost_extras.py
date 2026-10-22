from types import SimpleNamespace

import pytest

from app.services import gen_timing, llm_json
from app.services.model_pricing import estimate_cost_usd


def test_regional_uplift_is_explicit_config_default_off(monkeypatch):
    monkeypatch.delenv("OPENAI_REGIONAL_UPLIFT_PCT", raising=False)
    base = estimate_cost_usd("gpt-5.4-mini", 1000, 0, 1000)
    monkeypatch.setenv("OPENAI_REGIONAL_UPLIFT_PCT", "10")
    assert estimate_cost_usd("gpt-5.4-mini", 1000, 0, 1000) == pytest.approx(base * 1.10)
    # only the configured model family is uplifted
    assert estimate_cost_usd("gpt-4o-mini", 1000, 0, 1000) == pytest.approx((1000 * 0.15 + 1000 * 0.60) / 1_000_000)
    monkeypatch.setenv("OPENAI_REGIONAL_UPLIFT_PCT", "garbage")
    assert estimate_cost_usd("gpt-5.4-mini", 1000, 0, 1000) == pytest.approx(base)


def test_stage_a_and_stage_b_are_separate_callers(monkeypatch):
    usage = SimpleNamespace(
        prompt_tokens=100, completion_tokens=200,
        prompt_tokens_details=SimpleNamespace(cached_tokens=0),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=50),
    )

    class Completions:
        def create(self, **kw):
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok":1}'))], usage=usage)

    fake_client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    fake_client.with_options = lambda **kw: fake_client
    monkeypatch.setattr(llm_json, "get_openai_client", lambda: fake_client)
    monkeypatch.setattr(llm_json, "record_usage", lambda **kw: None)

    def _call_stage_a():
        return llm_json.chat_json(system="s", user="u", model="gpt-4o")

    def _call_stage_b():
        return llm_json.chat_json(system="s", user="u", model="gpt-5.4-mini", reasoning_effort="medium")

    with gen_timing.timed_request("language_elements", "sprachbausteine_1") as timer:
        _call_stage_a()
        _call_stage_b()
        s = gen_timing.finish(timer, "ok")

    keys = sorted(s["byCaller"])
    assert any(k.endswith("._call_stage_a") for k in keys) and any(k.endswith("._call_stage_b") for k in keys)
    b = next(v for k, v in s["byCaller"].items() if k.endswith("._call_stage_b"))
    assert b["models"] == ["gpt-5.4-mini:medium"] and b["reasoningTokens"] == 50
    assert s["reasoningTokens"] == 100 and s["completionTokens"] == 400

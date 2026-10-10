"""Phase 6 of the TTFT brief: is_reasoning_model only matched ^o\\d, so a
GPT-5-family OPENAI_GENERATE_MODEL silently got chat-model params
(max_tokens, no reasoning_effort, a temperature the API rejects) instead of
max_completion_tokens/reasoning_effort. llm_json.py's own
_MAX_COMPLETION_TOKENS_PREFIXES already groups gpt-5 with the reasoning-style
models for the german-exam call path; this pins the same classification for
chat_completion_params, which answer_stream/general_answer/dialogue_state/
notes_full all share.
"""
from __future__ import annotations

import pytest

from app.services.answer import chat_completion_params, is_reasoning_model, _needs_max_completion_tokens


@pytest.mark.parametrize("model", ["o1", "o1-mini", "o3", "o3-mini", "o4-mini"])
def test_is_reasoning_model_matches_o_series(model: str) -> None:
    assert is_reasoning_model(model)


@pytest.mark.parametrize("model", ["gpt-5", "gpt-5-mini", "gpt-5.4-mini", "gpt-5.1-nano"])
def test_is_reasoning_model_matches_gpt5_family(model: str) -> None:
    assert is_reasoning_model(model)


@pytest.mark.parametrize("model", ["gpt-4o", "gpt-4o-mini", None, ""])
def test_is_reasoning_model_false_for_ordinary_chat_models(model: str | None) -> None:
    assert not is_reasoning_model(model)


@pytest.mark.parametrize("model", ["gpt-5-chat", "gpt-5-chat-latest"])
def test_is_reasoning_model_excludes_gpt5_chat_variant(model: str) -> None:
    """gpt-5-chat is a plain chat model (temperature, no reasoning_effort)
    despite the gpt-5 name — must not be swept in by the prefix match."""
    assert not is_reasoning_model(model)


def test_needs_max_completion_tokens_covers_gpt41_and_gpt45_without_being_reasoning_models() -> None:
    """These need max_completion_tokens (same as reasoning models) but stay
    ordinary chat models otherwise — no reasoning_effort, temperature allowed."""
    for model in ("gpt-4.1", "gpt-4.1-mini", "gpt-4.5"):
        assert _needs_max_completion_tokens(model)
        assert not is_reasoning_model(model)
        params = chat_completion_params(model, 2000, temperature=0.2)
        assert params == {"max_completion_tokens": 2000, "temperature": 0.2}


def test_chat_completion_params_for_gpt5_uses_reasoning_shape(monkeypatch) -> None:
    from app.services import answer as answer_module

    monkeypatch.setattr(
        answer_module, "get_settings",
        lambda: type("S", (), {"openai_reasoning_effort": "medium"})(),
    )
    params = chat_completion_params("gpt-5.4-mini", 2000, temperature=0.2)
    assert params == {"max_completion_tokens": max(2000, 12000), "reasoning_effort": "medium"}
    assert "temperature" not in params


def test_chat_completion_params_reasoning_effort_override_wins_over_default(monkeypatch) -> None:
    from app.services import answer as answer_module

    monkeypatch.setattr(
        answer_module, "get_settings",
        lambda: type("S", (), {"openai_reasoning_effort": "high"})(),
    )
    params = chat_completion_params("gpt-5", 2000, reasoning_effort="low")
    assert params["reasoning_effort"] == "low"


def test_chat_completion_params_for_ordinary_chat_model_is_unaffected() -> None:
    params = chat_completion_params("gpt-4o-mini", 1500, temperature=0.3)
    assert params == {"max_tokens": 1500, "temperature": 0.3}

"""jev_client.py is not wired into any router yet -- these tests cover the
adapter's own contract in isolation: disabled-by-default short-circuiting,
typed parsing of each question type, and fail-closed behavior on any
transport/schema problem. No real network call is made; httpx.MockTransport
stands in for api.typesafe.ai."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from app.services import jev_client as jc


def _settings(**overrides) -> SimpleNamespace:
    base = dict(
        semantic_intent_jev_mode="enabled",
        jev_api_key="test-key",
        jev_model="jev-1.13.0",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _client_with(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _patch(monkeypatch, settings, client):
    monkeypatch.setattr(jc, "get_settings", lambda: settings)
    monkeypatch.setattr(jc, "_get_jev_client", lambda: client)


def test_off_mode_never_calls_network(monkeypatch):
    def _fail(request):
        raise AssertionError("must not call the network when mode is off")

    _patch(monkeypatch, _settings(semantic_intent_jev_mode="off"), _client_with(_fail))
    result = jc.ask_jev({"message": "hi"}, [jc.JevNoulQuestion("x", "x?")])
    assert result is None


def test_missing_api_key_never_calls_network(monkeypatch):
    def _fail(request):
        raise AssertionError("must not call the network without a key")

    _patch(monkeypatch, _settings(jev_api_key=None), _client_with(_fail))
    result = jc.ask_jev({"message": "hi"}, [jc.JevNoulQuestion("x", "x?")])
    assert result is None


def test_empty_questions_never_calls_network(monkeypatch):
    def _fail(request):
        raise AssertionError("must not call the network with no questions")

    _patch(monkeypatch, _settings(), _client_with(_fail))
    assert jc.ask_jev({"message": "hi"}, []) is None


def test_parses_choice_noul_and_score_answers(monkeypatch):
    def _handler(request):
        body = httpx.Response(200, json={
            "model": "jev-1.13.0",
            "answers": {
                "wants_hint": {"noul": 0.82},
                "intent": {"choice": "hint", "confidence": 0.9,
                           "probabilities": {"hint": 0.9, "full_solution": 0.1}},
                "depth": {"score": 2.0, "confidence": 0.7,
                          "probabilities": {"1": 0.1, "2": 0.7, "3": 0.2}},
            },
            "usage": {"input_tokens": 120, "output_tokens": 0},
        })
        return body

    _patch(monkeypatch, _settings(), _client_with(_handler))
    result = jc.ask_jev({"message": "give me a hint"}, [
        jc.JevNoulQuestion("wants_hint", "Does the student want only a hint?"),
        jc.JevChoiceQuestion("intent", "What does the student want?", ("hint", "full_solution")),
        jc.JevScoreQuestion("depth", "How detailed?", "brief", "thorough"),
    ])
    assert result is not None
    assert result.answers["wants_hint"] == jc.JevNoulAnswer(noul=0.82)
    assert result.answers["intent"].choice == "hint"
    assert result.answers["depth"].score == 2.0
    assert result.input_tokens == 120


@pytest.mark.parametrize("handler", [
    lambda request: httpx.Response(500, json={"error": "boom"}),
    lambda request: httpx.Response(200, json={"answers": {}}),  # missing requested question
    lambda request: (_ for _ in ()).throw(httpx.ConnectTimeout("timed out")),
])
def test_any_failure_mode_fails_closed(monkeypatch, handler):
    _patch(monkeypatch, _settings(), _client_with(handler))
    result = jc.ask_jev(
        {"message": "give me a hint"}, [jc.JevNoulQuestion("wants_hint", "?")],
    )
    assert result is None


def test_pinned_model_always_sent(monkeypatch):
    sent = {}

    def _handler(request):
        import json
        sent["payload"] = json.loads(request.content)
        return httpx.Response(200, json={"answers": {"x": {"noul": 0.1}}, "usage": {}})

    _patch(monkeypatch, _settings(jev_model="jev-1.13.0"), _client_with(_handler))
    jc.ask_jev({"message": "hi"}, [jc.JevNoulQuestion("x", "x?")])
    assert sent["payload"]["model"] == "jev-1.13.0"

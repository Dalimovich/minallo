"""Isolated adapter tests for app/services/jev_client.py -- zero real
network calls (a hard httpx tripwire proves it), disabled-by-default
behavior, and the "never reaches a live consumer" invariant this module's
own docstring claims."""

from __future__ import annotations

import json

import httpx
import pytest


def _install_network_tripwire(monkeypatch):
    def _raise(self, request, **_kwargs):  # noqa: ANN001
        raise AssertionError(f"BLOCKED: a real network call was attempted -- {request.method} {request.url}")
    monkeypatch.setattr(httpx.Client, "send", _raise)


def test_disabled_by_default_refuses_to_construct_a_client(monkeypatch):
    """setenv to explicit "off" values, not delenv: a local .env file with
    real credentials configured (this repo's own worktree, once an
    evaluation key is set up) is itself a valid pydantic-settings source
    independent of process env vars -- delenv only clears a process-level
    override, it can't suppress a value coming from the .env file, so it
    silently fails to simulate "disabled" whenever a real key happens to
    be configured locally. Explicit overrides are the only way this test
    is still meaningful once that's true."""
    from app.config import get_settings
    from app.services import jev_client

    monkeypatch.setenv("JEV_ADAPTER_ENABLED", "false")
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    monkeypatch.setenv("JEV_API_KEY", "")
    get_settings.cache_clear()
    try:
        with pytest.raises(jev_client.JevNotEnabledError):
            jev_client.construct_client()
    finally:
        get_settings.cache_clear()


def test_enabled_without_api_key_still_refuses(monkeypatch):
    from app.config import get_settings
    from app.services import jev_client

    monkeypatch.setenv("JEV_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("TYPESAFE_API_KEY", "")
    monkeypatch.setenv("JEV_API_KEY", "")
    get_settings.cache_clear()
    try:
        with pytest.raises(jev_client.JevNotEnabledError):
            jev_client.construct_client()
    finally:
        get_settings.cache_clear()


def test_enabled_with_key_constructs_and_round_trips_a_mocked_response(monkeypatch):
    from app.config import get_settings
    from app.services import jev_client

    monkeypatch.setenv("JEV_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key-not-real")
    get_settings.cache_clear()

    captured = []

    def fake_send(self, request, **_kwargs):
        assert str(request.url) == jev_client.JEV_ENDPOINT
        assert request.headers["authorization"] == "Bearer test-key-not-real"
        body = json.loads(request.content)
        captured.append(body)
        return httpx.Response(
            200,
            json={
                "model": "jev-1.14.0",
                "answers": {
                    "is_urgent": {"type": "noul", "noul": 0.87},
                    "target_exercise": {
                        "type": "choice", "choice": "4", "confidence": 0.91,
                        "probabilities": {"4": 0.91, "5": 0.06, "none": 0.03},
                    },
                },
                "usage": {"input_tokens": 42, "output_tokens": 0},
            },
            request=request,
        )

    monkeypatch.setattr(httpx.Client, "send", fake_send)

    try:
        client = jev_client.construct_client()
        try:
            result = client.ask(
                state="hey im stuck on number 4, what am i even supposed to do here",
                questions={
                    "is_urgent": jev_client.NoulQuestion(instructions="The student sounds stuck or confused"),
                    "target_exercise": jev_client.ChoiceQuestion(
                        instructions="Which exercise is the student referring to?",
                        options={"4": "Exercise 4", "5": "Exercise 5", "none": None},
                    ),
                },
            )
        finally:
            client.close()
    finally:
        get_settings.cache_clear()

    assert len(captured) == 1
    assert captured[0]["questions"]["is_urgent"]["type"] == "noul"
    assert captured[0]["questions"]["target_exercise"]["criteria"] == {
        "4": "Exercise 4", "5": "Exercise 5", "none": None,
    }
    assert result.model == "jev-1.14.0"
    assert result.answers["is_urgent"].noul == 0.87
    assert result.answers["target_exercise"].choice == "4"
    assert result.answers["target_exercise"].confidence == 0.91
    assert result.input_tokens == 42


def test_module_is_never_imported_by_a_live_consumer():
    """Mirrors diagnostic_policy.py's own enforced invariant for the same
    reason: this is an evaluation-only adapter, not wired into anything
    that can affect a real student-facing response."""
    import pathlib

    live_paths = [
        "app/routers/stream.py", "app/routers/ask.py",
        "app/services/answer.py", "app/services/answer_stream.py",
        "app/services/general_answer.py", "app/services/visual_repair.py",
        "app/services/cache.py", "app/services/course_grounding.py",
        "app/services/semantic_intent_orchestrator.py", "app/services/student_intent.py",
    ]
    root = pathlib.Path(__file__).resolve().parents[1]
    for rel in live_paths:
        text = (root / rel).read_text(encoding="utf-8")
        assert "jev_client" not in text, f"{rel} must not import jev_client -- it is evaluation-only"


def test_no_real_network_reachable_without_explicit_mock(monkeypatch):
    """Belt-and-suspenders: even WITH the adapter enabled and a (fake)
    key, nothing in this test file's OTHER tests can accidentally reach
    a real endpoint, because every test either expects construct_client
    to refuse, or installs its own fake transport first."""
    from app.config import get_settings
    from app.services import jev_client

    _install_network_tripwire(monkeypatch)
    monkeypatch.setenv("JEV_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key-not-real")
    get_settings.cache_clear()
    try:
        client = jev_client.construct_client()
        try:
            with pytest.raises(AssertionError, match="BLOCKED"):
                client.ask(state="x", questions={"q": jev_client.NoulQuestion(instructions="x")})
        finally:
            client.close()
    finally:
        get_settings.cache_clear()

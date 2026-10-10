"""Phase 2 of the TTFT brief (cheap preflight wins):

- require_active_subscription + enforce_interactive_cap now run concurrently
  in ask_stream_endpoint, but 402 must still win over 429 when both would
  reject; enforce_rate_limit must still only run once both pass, since it
  writes a security_events row even on its own success path.
- the dialogue-state classifier now runs with a tight timeout + no retries,
  but must still fail closed to the lexical fallback on any error.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException


# ── access_control.py: unit-level behavior the brief asks to pin ───────────

class _FakeResp:
    def __init__(self, data=None, count=None):
        self.data = data or []
        self.count = count


class _FakeQuery:
    """Chainable stand-in for a postgrest query builder: every attribute
    access returns a chain-continuing callable, and .execute() returns the
    canned response regardless of how it got there."""

    def __init__(self, resp):
        self._resp = resp

    def __getattr__(self, _name):
        def _chain(*_a, **_k):
            return self
        return _chain

    def execute(self):
        return self._resp


class _FakeSupabase:
    def __init__(self, resp):
        self._resp = resp

    def table(self, _name):
        return _FakeQuery(self._resp)


def test_require_active_subscription_raises_402_when_no_row(monkeypatch):
    from app.services import access_control

    monkeypatch.setattr(access_control, "get_supabase", lambda: _FakeSupabase(_FakeResp(data=[])))
    monkeypatch.setattr(access_control, "_log_security_event", lambda *a, **k: None)
    with pytest.raises(HTTPException) as exc_info:
        access_control.require_active_subscription("user-1", "ask_stream")
    assert exc_info.value.status_code == 402


def test_require_active_subscription_passes_when_active_and_not_expired(monkeypatch):
    from app.services import access_control

    row = {"status": "active", "expires_at": "2099-01-01T00:00:00Z"}
    monkeypatch.setattr(access_control, "get_supabase", lambda: _FakeSupabase(_FakeResp(data=[row])))
    access_control.require_active_subscription("user-1", "ask_stream")  # must not raise


def test_enforce_interactive_cap_raises_429_with_bucket_body(monkeypatch):
    from app.services import access_control

    monkeypatch.setattr(access_control, "get_supabase", lambda: _FakeSupabase(_FakeResp(count=999)))
    monkeypatch.setattr(access_control, "_log_security_event", lambda *a, **k: None)
    with pytest.raises(HTTPException) as exc_info:
        access_control.enforce_interactive_cap("user-1", 10)
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail["code"] == "ai_monthly_cap"
    assert exc_info.value.detail["bucket"] == "interactive"


def test_enforce_rate_limit_raises_429_with_retry_after(monkeypatch):
    from app.services import access_control

    monkeypatch.setattr(access_control, "get_supabase", lambda: _FakeSupabase(_FakeResp(count=999)))
    monkeypatch.setattr(access_control, "_log_security_event", lambda *a, **k: None)
    with pytest.raises(HTTPException) as exc_info:
        access_control.enforce_rate_limit("user-1", "ask_stream", 10, 60)
    assert exc_info.value.status_code == 429
    assert exc_info.value.headers["Retry-After"] == "60"


def test_enforce_rate_limit_passes_and_logs_event_when_under_limit(monkeypatch):
    from app.services import access_control

    logged = []
    monkeypatch.setattr(access_control, "get_supabase", lambda: _FakeSupabase(_FakeResp(count=0)))
    monkeypatch.setattr(access_control, "_log_security_event", lambda user_id, event_type, *a: logged.append(event_type))
    access_control.enforce_rate_limit("user-1", "ask_stream", 10, 60)
    assert logged == ["ask_stream"]


# ── ask_stream_endpoint: concurrency must not change outcome priority ──────

def test_subscription_failure_wins_over_cap_failure(monkeypatch):
    """Both checks now run concurrently (asyncio.gather) — the 402 must still
    be the one the caller sees, not whichever of the two happened to finish
    first or raise last out of gather's return_exceptions=True list."""
    from app.routers import stream as stream_router

    monkeypatch.setattr(
        stream_router, "require_active_subscription",
        lambda *_: (_ for _ in ()).throw(HTTPException(status_code=402, detail="no subscription")),
    )
    monkeypatch.setattr(
        stream_router, "enforce_interactive_cap",
        lambda *_: (_ for _ in ()).throw(HTTPException(status_code=429, detail="cap reached")),
    )
    monkeypatch.setattr(
        stream_router, "enforce_rate_limit",
        lambda *_: (_ for _ in ()).throw(AssertionError("rate limit must not run when subscription/cap already failed")),
    )
    payload = stream_router.AskStreamRequest(courseId="", question="hello")
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(stream_router.ask_stream_endpoint(payload, {"id": "user-1"}))
    assert exc_info.value.status_code == 402


def test_cap_failure_raised_when_subscription_passes(monkeypatch):
    from app.routers import stream as stream_router

    monkeypatch.setattr(stream_router, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(
        stream_router, "enforce_interactive_cap",
        lambda *_: (_ for _ in ()).throw(HTTPException(status_code=429, detail="cap reached")),
    )
    monkeypatch.setattr(
        stream_router, "enforce_rate_limit",
        lambda *_: (_ for _ in ()).throw(AssertionError("rate limit must not run when cap already failed")),
    )
    payload = stream_router.AskStreamRequest(courseId="", question="hello")
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(stream_router.ask_stream_endpoint(payload, {"id": "user-1"}))
    assert exc_info.value.status_code == 429


def test_rate_limit_runs_only_after_subscription_and_cap_both_pass(monkeypatch):
    from app.routers import stream as stream_router

    calls: list[str] = []
    monkeypatch.setattr(stream_router, "require_active_subscription", lambda *_: calls.append("subscription"))
    monkeypatch.setattr(stream_router, "enforce_interactive_cap", lambda *_: calls.append("cap"))

    def _rate_limit(*_a, **_k):
        calls.append("rate_limit")
        raise HTTPException(status_code=429, detail="stop here before the heavier pipeline")

    monkeypatch.setattr(stream_router, "enforce_rate_limit", _rate_limit)
    payload = stream_router.AskStreamRequest(courseId="", question="hello")
    with pytest.raises(HTTPException):
        asyncio.run(stream_router.ask_stream_endpoint(payload, {"id": "user-1"}))
    assert calls == ["subscription", "cap", "rate_limit"] or (
        "rate_limit" in calls
        and calls.index("rate_limit") > calls.index("subscription")
        and calls.index("rate_limit") > calls.index("cap")
    )


# ── dialogue_state.py: tight classifier timeout must still fail closed ─────

def test_classifier_failure_still_falls_back_safely(monkeypatch):
    """A stalled/erroring classifier call must not surface — it already fell
    back to the lexical resolution before this change; tightening the
    timeout and disabling retries must not weaken that guarantee."""
    from app.services import dialogue_state, openai_client

    captured_kwargs: dict = {}

    class _FakeCompletions:
        @staticmethod
        def create(**kwargs):
            captured_kwargs.update(kwargs)
            raise TimeoutError("simulated stall")

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeClient:
        chat = _FakeChat()

        def with_options(self, **_kwargs):
            return self

    monkeypatch.setattr(openai_client, "get_openai_client", lambda: _FakeClient())

    turns = [
        {"role": "user", "text": "Create flashcards about bearings."},
        {"role": "assistant", "text": "Should I make the same set for screws?"},
    ]
    base = dialogue_state.resolve_dialogue("go ahead", previous_turns=turns)
    resolved = dialogue_state.resolve_dialogue_semantically("go ahead", previous_turns=turns, base=base)
    assert resolved is not None  # fell back without raising
    assert captured_kwargs.get("timeout") == openai_client.INTERACTIVE_CLASSIFIER_TIMEOUT


def test_classifier_uses_no_retries_and_tight_timeout(monkeypatch):
    from app.services import dialogue_state, openai_client

    with_options_calls = []

    class _FakeCompletions:
        @staticmethod
        def create(**kwargs):
            return type("Completion", (), {
                "choices": [type("Choice", (), {
                    "message": type("Msg", (), {"content": '{"relation":"new_topic","speechAct":"question",'
                                                             '"taskFamily":"explain","continuesPreviousGoal":false,'
                                                             '"resolvedRequest":"test","confidence":0.9}'})(),
                })()],
            })()

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeClient:
        chat = _FakeChat()

        def with_options(self, **kwargs):
            with_options_calls.append(kwargs)
            return self

    monkeypatch.setattr(openai_client, "get_openai_client", lambda: _FakeClient())

    turns = [
        {"role": "user", "text": "Explain welding from my course."},
        {"role": "assistant", "text": "Welding joins materials."},
    ]
    base = dialogue_state.resolve_dialogue("why?", previous_turns=turns)
    dialogue_state.resolve_dialogue_semantically("why?", previous_turns=turns, base=base)
    assert with_options_calls == [{"max_retries": 0}]
    assert openai_client.INTERACTIVE_CLASSIFIER_TIMEOUT.read == 2.5


# ── jwt_auth.py: pooled client is reused and closes cleanly ────────────────

def test_auth_client_is_reused_across_calls_and_closes(monkeypatch):
    from app import jwt_auth

    # Reset any client a previous test may have left behind.
    asyncio.run(jwt_auth.aclose_auth_client())
    first = jwt_auth._get_auth_client()
    second = jwt_auth._get_auth_client()
    assert first is second
    asyncio.run(jwt_auth.aclose_auth_client())
    assert jwt_auth._auth_client is None
    third = jwt_auth._get_auth_client()
    assert third is not first
    asyncio.run(jwt_auth.aclose_auth_client())

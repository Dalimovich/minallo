"""Phase 1 (TTFT fix A): general-knowledge and web answers now stream real
model deltas instead of generating the full answer first and slicing it.
These tests pin the SSE contract so _stream_live_answer stays a drop-in
replacement for _stream_static_answer, and that stream_general_answer /
stream_web_answer degrade the same way their non-streaming siblings did.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.services.source_router import (
    CourseFileScope,
    GroundingPolicy,
    SourceDecision,
    SourceMode,
    SourceScope,
)


def _decision(**overrides) -> SourceDecision:
    defaults = dict(
        selected_source_mode=SourceMode.AUTO,
        source_scope=SourceScope.GENERAL_KNOWLEDGE,
        course_file_scope=CourseFileScope.ALL_COURSE_FILES,
        source_label="Using: General knowledge",
        grounding_policy=GroundingPolicy.GENERAL,
    )
    defaults.update(overrides)
    return SourceDecision(**defaults)


async def _consume(response) -> list[dict]:
    events = []
    async for raw in response.body_iterator:
        for line in raw.decode().splitlines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


# ── _stream_live_answer: same SSE contract as _stream_static_answer ────────

def test_stream_live_answer_matches_static_answer_event_contract():
    from app.routers.stream import _stream_live_answer, _stream_static_answer

    decision = _decision()
    static_events = asyncio.run(_consume(_stream_static_answer(
        text="Hello world", decision=decision, answer_mode="general",
        model="test-model", prompt_tokens=5, completion_tokens=7,
        status_key="writing_answer",
    )))
    live_events = asyncio.run(_consume(_stream_live_answer(
        events=iter([
            {"t": "Hello "}, {"t": "world"},
            {"done": True, "model": "test-model", "promptTokens": 5, "completionTokens": 7},
        ]),
        decision=decision, answer_mode="general", status_key="writing_answer",
        request_id="live-contract-1",
    )))

    static_meta = next(e for e in static_events if e.get("meta"))
    live_meta = next(e for e in live_events if e.get("meta"))
    assert set(static_meta) == set(live_meta)
    assert {k: v for k, v in static_meta.items() if k != "meta"} == \
           {k: v for k, v in live_meta.items() if k != "meta"}

    static_done = next(e for e in static_events if e.get("done"))
    live_done = next(e for e in live_events if e.get("done"))
    assert set(static_done) == set(live_done)
    assert static_done == live_done

    assert "".join(e["t"] for e in live_events if "t" in e) == "Hello world"


def test_stream_live_answer_emits_tokens_before_terminal_event():
    from app.routers.stream import _stream_live_answer

    events = asyncio.run(_consume(_stream_live_answer(
        events=iter([{"t": "partial answer "}, {"done": True, "model": "m"}]),
        decision=_decision(), answer_mode="general", request_id="live-order-1",
    )))
    token_index = next(i for i, e in enumerate(events) if "t" in e)
    done_index = next(i for i, e in enumerate(events) if e.get("done"))
    assert token_index < done_index


async def _consume_like_early_stream(response) -> list[dict]:
    """early_stream (the real consumer of this generator) breaks its loop the
    moment it sees a terminal SSE event and never calls __anext__ again — so
    a regression test that drains the body_iterator fully (like _consume
    above) can't catch code placed after the done/error yield. This mirrors
    the real stop-reading-at-the-terminal-event behavior instead."""
    events = []
    it = response.body_iterator.__aiter__()
    async for raw in it:
        for line in raw.decode().splitlines():
            if line.startswith("data: "):
                event = json.loads(line[6:])
                events.append(event)
                if event.get("done") or event.get("error"):
                    return events
    return events


def test_stream_live_answer_on_finish_runs_before_the_consumer_can_stop_reading():
    """Regression: on_finish (record_usage) used to run AFTER yielding the
    done event, so once early_stream stopped reading at that same done
    event, on_finish's code never got a chance to execute — usage silently
    stopped being recorded for every general/web answer."""
    from app.routers.stream import _stream_live_answer

    finished: list[dict] = []
    response = _stream_live_answer(
        events=iter([{"t": "answer text"}, {"done": True, "model": "m", "promptTokens": 3, "completionTokens": 4}]),
        decision=_decision(), answer_mode="general", request_id="on-finish-1",
        on_finish=lambda final: finished.append(final),
    )
    events = asyncio.run(_consume_like_early_stream(response))
    assert any(e.get("done") for e in events)
    assert finished, "on_finish never ran even though the consumer saw the done event"
    assert finished[0]["model"] == "m"


def test_stream_live_answer_mid_stream_exception_reports_partial_answer():
    from app.routers.stream import _stream_live_answer

    def boom():
        yield {"t": "a partial draft"}
        raise RuntimeError("provider connection dropped")

    events = asyncio.run(_consume(_stream_live_answer(
        events=boom(), decision=_decision(), answer_mode="general",
        request_id="live-error-1",
    )))
    terminals = [e for e in events if e.get("error") or e.get("done")]
    assert len(terminals) == 1
    assert terminals[0]["error"] is True
    assert terminals[0]["partialAnswerAvailable"] is True
    assert terminals[0]["code"] == "live_generation_failed"


def test_stream_live_answer_empty_completion_is_error():
    from app.routers.stream import _stream_live_answer

    events = asyncio.run(_consume(_stream_live_answer(
        events=iter([{"done": True, "model": "m"}]),
        decision=_decision(), answer_mode="general", request_id="live-empty-1",
    )))
    terminals = [e for e in events if e.get("error") or e.get("done")]
    assert len(terminals) == 1
    assert terminals[0]["code"] == "empty_completed_response"
    assert terminals[0]["partialAnswerAvailable"] is False


def test_stream_live_answer_no_terminal_event_is_error():
    from app.routers.stream import _stream_live_answer

    events = asyncio.run(_consume(_stream_live_answer(
        events=iter([{"t": "answer with no done event"}]),
        decision=_decision(), answer_mode="general", request_id="live-no-terminal-1",
    )))
    terminals = [e for e in events if e.get("error") or e.get("done")]
    assert len(terminals) == 1
    assert terminals[0]["code"] == "stream_ended_without_terminal_event"
    assert terminals[0]["partialAnswerAvailable"] is True


def test_stream_live_answer_maps_sources_and_decision_from_final_event():
    from app.routers.stream import _stream_live_answer
    from dataclasses import replace

    decision = _decision(source_scope=SourceScope.INTERNET, web_search_used=False)
    events = asyncio.run(_consume(_stream_live_answer(
        events=iter([
            {"t": "web answer text"},
            {"done": True, "model": "m", "webSources": [{"title": "Example", "url": "https://example.com"}]},
        ]),
        decision=decision, answer_mode="internet", request_id="live-sources-1",
        map_sources=lambda final: [
            {"file_name": s["title"], "url": s["url"]} for s in final.get("webSources") or []
        ],
        decision_for_done=lambda final: replace(decision, web_search_used=bool(final.get("webSources"))),
    )))
    done = next(e for e in events if e.get("done"))
    assert done["sources"] == [{"file_name": "Example", "url": "https://example.com"}]


# ── stream_general_answer: prefix + metering/timeout wiring ─────────────────

class _FakeChunk:
    def __init__(self, content=None, usage=None):
        delta = type("Delta", (), {"content": content})()
        choice = type("Choice", (), {"delta": delta})()
        self.choices = [choice] if content is not None else []
        self.usage = usage


def test_stream_general_answer_yields_prefix_before_any_model_call(monkeypatch):
    from app.services import general_answer

    create_calls = []

    class _FakeStream:
        def __iter__(self):
            usage = type("Usage", (), {"prompt_tokens": 3, "completion_tokens": 4})()
            yield _FakeChunk("Real model text")
            yield _FakeChunk(None, usage=usage)

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    create_calls.append(kwargs)
                    return _FakeStream()

    monkeypatch.setattr(general_answer, "get_openai_client", lambda: _FakeClient())

    events = list(general_answer.stream_general_answer("A question", prefix="Note: "))

    assert events[0] == {"t": "Note: ", "model": general_answer.get_settings().openai_generate_model}
    assert events[1]["t"] == "Real model text"
    assert events[-1] == {
        "done": True, "model": general_answer.get_settings().openai_generate_model,
        "promptTokens": 3, "completionTokens": 4,
    }
    # The prefix must be yielded before the (blocking) OpenAI call happens —
    # that's the whole TTFT point — so create() shouldn't run until the
    # generator is driven past the first event.
    assert create_calls, "expected the fake OpenAI client to have been called"
    assert create_calls[0]["stream_options"] == {"include_usage": True}
    assert "timeout" in create_calls[0]


def test_stream_general_answer_without_prefix_emits_no_prefix_event(monkeypatch):
    from app.services import general_answer

    class _FakeStream:
        def __iter__(self):
            yield _FakeChunk("Only real text")

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    return _FakeStream()

    monkeypatch.setattr(general_answer, "get_openai_client", lambda: _FakeClient())

    events = list(general_answer.stream_general_answer("A question"))
    assert all(e.get("t") != "" for e in events)
    assert events[0]["t"] == "Only real text"


# ── stream_web_answer: live deltas, degrade like generate_web_answer did ───

class _FakeDeltaEvent:
    type = "response.output_text.delta"

    def __init__(self, delta):
        self.delta = delta


class _FakeCompletedEvent:
    type = "response.completed"

    def __init__(self, response):
        self.response = response


class _FakeIncompleteEvent:
    type = "response.incomplete"

    def __init__(self, response):
        self.response = response


class _FakeFailedEvent:
    type = "response.failed"

    def __init__(self, response=None, message=None):
        self.response = response
        self.message = message


class _FakeErrorEvent:
    type = "error"

    def __init__(self, message):
        self.message = message


def _fake_settings(*, web_search_enabled: bool):
    from types import SimpleNamespace
    return SimpleNamespace(web_search_enabled=web_search_enabled, web_search_model="test-model")


def test_stream_web_answer_streams_deltas_then_final_sources(monkeypatch):
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=True))

    class _FakeResponse:
        output_text = "A current fact."
        output = []
        usage = type("Usage", (), {"input_tokens": 11, "output_tokens": 22})()

    class _FakeClient:
        class responses:
            @staticmethod
            def create(**kwargs):
                assert kwargs["stream"] is True
                return iter([
                    _FakeDeltaEvent("A current "),
                    _FakeDeltaEvent("fact."),
                    _FakeCompletedEvent(_FakeResponse()),
                ])

    monkeypatch.setattr(web_answer, "get_openai_client", lambda: _FakeClient())

    events = list(web_answer.stream_web_answer("question", query="question"))
    tokens = "".join(e["t"] for e in events if "t" in e)
    assert tokens == "A current fact."
    done = events[-1]
    assert done["done"] is True
    assert done["promptTokens"] == 11
    assert done["completionTokens"] == 22


def test_stream_web_answer_incomplete_still_finishes_with_streamed_text(monkeypatch):
    """response.incomplete (max_output_tokens reached mid-answer) must finish
    like response.completed does — the text already streamed via deltas is
    real and must not be discarded as a failure just because it was cut off."""
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=True))

    class _FakeResponse:
        output_text = "A current fact, cut off mid-sent"
        output = []
        usage = type("Usage", (), {"input_tokens": 11, "output_tokens": 22})()

    class _FakeClient:
        class responses:
            @staticmethod
            def create(**kwargs):
                return iter([
                    _FakeDeltaEvent("A current "),
                    _FakeDeltaEvent("fact, cut off mid-sent"),
                    _FakeIncompleteEvent(_FakeResponse()),
                ])

    monkeypatch.setattr(web_answer, "get_openai_client", lambda: _FakeClient())

    events = list(web_answer.stream_web_answer("question", query="question"))
    tokens = "".join(e["t"] for e in events if "t" in e)
    assert tokens == "A current fact, cut off mid-sent"
    done = events[-1]
    assert done["done"] is True
    assert done["promptTokens"] == 11


def test_stream_web_answer_failed_before_first_delta_falls_back(monkeypatch):
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=True))

    class _FakeClient:
        class responses:
            @staticmethod
            def create(**kwargs):
                return iter([_FakeFailedEvent(message="provider error")])

    monkeypatch.setattr(web_answer, "get_openai_client", lambda: _FakeClient())

    events = list(web_answer.stream_web_answer("question", query="question"))
    assert events[0] == {"t": web_answer.INTERNET_UNAVAILABLE_MESSAGE}
    assert events[-1]["done"] is True
    assert events[-1]["webSources"] == []


def test_stream_web_answer_error_event_after_first_delta_propagates(monkeypatch):
    """A response.failed/error EVENT (not a raised exception) after real
    tokens were already streamed must propagate too, same as a mid-stream
    exception — _stream_live_answer needs this to mark the SSE error event
    partialAnswerAvailable=True instead of silently discarding what the
    student already saw."""
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=True))

    class _FakeClient:
        class responses:
            @staticmethod
            def create(**kwargs):
                return iter([
                    _FakeDeltaEvent("Some real text"),
                    _FakeErrorEvent("provider dropped mid-stream"),
                ])

    monkeypatch.setattr(web_answer, "get_openai_client", lambda: _FakeClient())

    gen = web_answer.stream_web_answer("question", query="question")
    first = next(gen)
    assert first == {"t": "Some real text"}
    with pytest.raises(RuntimeError, match="provider dropped mid-stream"):
        next(gen)


def test_stream_web_answer_falls_back_before_first_delta(monkeypatch):
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=True))

    class _FakeClient:
        class responses:
            @staticmethod
            def create(**kwargs):
                raise RuntimeError("provider unavailable")

    monkeypatch.setattr(web_answer, "get_openai_client", lambda: _FakeClient())

    events = list(web_answer.stream_web_answer("question", query="question"))
    assert events[0] == {"t": web_answer.INTERNET_UNAVAILABLE_MESSAGE}
    assert events[-1]["done"] is True
    assert events[-1]["webSources"] == []


def test_stream_web_answer_disabled_setting_is_unavailable(monkeypatch):
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=False))

    events = list(web_answer.stream_web_answer("question", query="question"))
    assert events[0] == {"t": web_answer.INTERNET_UNAVAILABLE_MESSAGE}
    assert events[-1]["done"] is True


def test_stream_web_answer_error_after_first_delta_propagates(monkeypatch):
    """Once tokens are already on the wire, a mid-stream failure must not be
    silently swallowed into the unavailable message — the caller
    (_stream_live_answer) needs the exception to mark the error SSE event
    partialAnswerAvailable=True instead."""
    from app.services import web_answer

    monkeypatch.setattr(web_answer, "get_settings", lambda: _fake_settings(web_search_enabled=True))

    def _boom_mid_stream():
        yield _FakeDeltaEvent("Some real text")
        raise RuntimeError("dropped mid-stream")

    class _FakeClient:
        class responses:
            @staticmethod
            def create(**kwargs):
                return _boom_mid_stream()

    monkeypatch.setattr(web_answer, "get_openai_client", lambda: _FakeClient())

    gen = web_answer.stream_web_answer("question", query="question")
    first = next(gen)
    assert first == {"t": "Some real text"}
    try:
        next(gen)
        assert False, "expected the mid-stream failure to propagate"
    except RuntimeError:
        pass

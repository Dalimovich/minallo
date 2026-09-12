"""Tests for the fire-and-forget usage meter (pure parts only — the daemon
writer thread is exercised in production; here we verify event shaping)."""

from __future__ import annotations

from app.services import usage_meter


class _Details:
    cached_tokens = 32


class _Usage:
    prompt_tokens = 100
    completion_tokens = 7
    prompt_tokens_details = _Details()


class _Resp:
    usage = _Usage()


def test_usage_from_response_extracts_tokens():
    out = usage_meter.usage_from_response(_Resp())
    assert out == {"prompt_tokens": 100, "completion_tokens": 7, "cached_tokens": 32}


def test_usage_from_response_tolerates_missing_usage():
    class Bare:
        pass

    assert usage_meter.usage_from_response(Bare()) == {
        "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0,
    }
    assert usage_meter.usage_from_response(None) == {
        "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0,
    }


def test_record_usage_skips_zero_token_events(monkeypatch):
    monkeypatch.setattr(usage_meter, "_ensure_worker", lambda: None)
    before = usage_meter._queue.qsize()
    usage_meter.record_usage(feature="x", model="m", prompt_tokens=0, completion_tokens=0)
    usage_meter.record_usage(feature="x", model="m", prompt_tokens=None, completion_tokens=None)
    assert usage_meter._queue.qsize() == before


def test_record_usage_shapes_event(monkeypatch):
    monkeypatch.setattr(usage_meter, "_ensure_worker", lambda: None)
    usage_meter.record_usage(
        feature="ask_stream", model="gpt-4o-mini",
        prompt_tokens=10, completion_tokens=2, cached_tokens=None,
        user_id="",  # falsy user → stored as NULL, not ""
    )
    evt = usage_meter._queue.get_nowait()
    assert evt == {
        "user_id": None,
        "feature": "ask_stream",
        "model": "gpt-4o-mini",
        "prompt_tokens": 10,
        "completion_tokens": 2,
        "cached_tokens": 0,
    }

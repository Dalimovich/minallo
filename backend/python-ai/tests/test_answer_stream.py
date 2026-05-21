"""Unit tests for answer_stream helpers. No network, no DB."""

from __future__ import annotations


# ── Previous-turns trimming ─────────────────────────────────────────────────


def test_trim_previous_turns_keeps_recent_within_caps() -> None:
    """The trim helper feeds the OpenAI messages array. It must convert
    role/text shape to role/content, keep only user+assistant turns, and
    cap the most recent N messages so prompt size stays predictable."""
    from app.services.answer_stream import _trim_previous_turns

    turns = [
        {"role": "user",       "text": "Q1"},
        {"role": "assistant",  "text": "A1"},
        {"role": "user",       "text": "Q2"},
        {"role": "assistant",  "text": "A2"},
    ]
    out = _trim_previous_turns(turns)
    assert out == [
        {"role": "user",      "content": "Q1"},
        {"role": "assistant", "content": "A1"},
        {"role": "user",      "content": "Q2"},
        {"role": "assistant", "content": "A2"},
    ]


def test_trim_previous_turns_drops_unknown_roles() -> None:
    """A client should never send role=system in previousTurns (the
    system prompt is owned by the server). Silently drop anything that
    isn't user or assistant rather than letting it slip into the
    messages array."""
    from app.services.answer_stream import _trim_previous_turns

    turns = [
        {"role": "system",     "text": "ignored"},
        {"role": "user",       "text": "real Q"},
        {"role": "function",   "text": "ignored"},
        {"role": "assistant",  "text": "real A"},
        {"role": "",           "text": "ignored"},
    ]
    out = _trim_previous_turns(turns)
    assert [m["role"] for m in out] == ["user", "assistant"]
    assert [m["content"] for m in out] == ["real Q", "real A"]


def test_trim_previous_turns_drops_blank_text() -> None:
    """Empty / whitespace-only turns add no value and waste tokens."""
    from app.services.answer_stream import _trim_previous_turns

    turns = [
        {"role": "user",      "text": ""},
        {"role": "assistant", "text": "   "},
        {"role": "user",      "text": "real"},
    ]
    out = _trim_previous_turns(turns)
    assert len(out) == 1
    assert out[0]["content"] == "real"


def test_trim_previous_turns_truncates_long_turn() -> None:
    """A single very long answer (e.g. a previous worksheet solution)
    must be capped so it can't crowd out room for the current turn."""
    from app.services.answer_stream import _trim_previous_turns, _MAX_TURN_CHARS

    long_text = "X" * (_MAX_TURN_CHARS + 500)
    turns = [{"role": "assistant", "text": long_text}]
    out = _trim_previous_turns(turns)
    assert len(out) == 1
    assert len(out[0]["content"]) <= _MAX_TURN_CHARS + 5  # +5 for trailing ellipsis
    assert out[0]["content"].endswith("…")


def test_trim_previous_turns_drops_oldest_when_total_exceeds_budget() -> None:
    """When the running char total exceeds the global cap, drop the
    OLDEST turns — those are least likely to be referenced by the
    follow-up question."""
    from app.services.answer_stream import _trim_previous_turns, _MAX_HISTORY_CHARS, _MAX_TURN_CHARS

    # Each turn is at the per-turn cap; together they exceed the global
    # char budget. _MAX_HISTORY_MESSAGES (6) is bigger than the count we
    # send here so message-count isn't the limiter — char budget is.
    big_text = "Y" * _MAX_TURN_CHARS
    turns = [{"role": "user" if i % 2 == 0 else "assistant", "text": f"turn-{i} {big_text}"}
             for i in range(5)]
    out = _trim_previous_turns(turns)
    total_chars = sum(len(m["content"]) for m in out)
    assert total_chars <= _MAX_HISTORY_CHARS
    # The retained turns are the MOST RECENT ones — the last one in the
    # input must always be retained (current follow-up most likely refers
    # to the freshest context).
    assert out[-1]["content"].startswith("turn-4")


def test_trim_previous_turns_caps_message_count() -> None:
    """Even if every turn is tiny, only the last _MAX_HISTORY_MESSAGES
    enter the prompt."""
    from app.services.answer_stream import _trim_previous_turns, _MAX_HISTORY_MESSAGES

    turns = [{"role": "user" if i % 2 == 0 else "assistant",
              "text": f"t{i}"} for i in range(_MAX_HISTORY_MESSAGES + 4)]
    out = _trim_previous_turns(turns)
    assert len(out) == _MAX_HISTORY_MESSAGES
    # First retained turn is the (N+4 - N)-th = 4th of the input.
    assert out[0]["content"] == "t4"


def test_trim_previous_turns_handles_none_and_empty() -> None:
    """Safe defaults — None or [] means "no history" and returns []."""
    from app.services.answer_stream import _trim_previous_turns

    assert _trim_previous_turns(None) == []
    assert _trim_previous_turns([]) == []


# ── Cache key fold-in for previousTurns ─────────────────────────────────────


def test_question_hash_changes_with_previous_turns() -> None:
    """Two students asking 'explain that again' in different chat
    sessions reference different prior turns — they must NOT collide
    in the cache."""
    from app.services.cache import question_hash

    base = question_hash("explain that again")
    with_session_a = question_hash(
        "explain that again",
        previous_turns=[
            {"role": "user", "text": "what is Nachgiebigkeit?"},
            {"role": "assistant", "text": "It is the inverse of stiffness, …"},
        ],
    )
    with_session_b = question_hash(
        "explain that again",
        previous_turns=[
            {"role": "user", "text": "how do welds work?"},
            {"role": "assistant", "text": "A weld joins two parts via …"},
        ],
    )
    # All three must be distinct — base ≠ session A ≠ session B.
    assert base != with_session_a
    assert base != with_session_b
    assert with_session_a != with_session_b


def test_question_hash_stable_for_same_previous_turns() -> None:
    """The hash must be deterministic — same turns ↦ same key.
    Otherwise the cache would never hit."""
    from app.services.cache import question_hash

    prev = [
        {"role": "user", "text": "what is the formula for δ_S?"},
        {"role": "assistant", "text": "δ_S = δ_K + Σδ_i + δ_G + δ_M"},
    ]
    h1 = question_hash("now substitute the values", previous_turns=prev)
    h2 = question_hash("now substitute the values", previous_turns=prev)
    assert h1 == h2

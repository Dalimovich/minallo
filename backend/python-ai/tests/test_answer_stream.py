"""Unit tests for answer_stream helpers. No network, no DB."""

from __future__ import annotations


def test_final_language_rule_ignores_foreign_exercise_labels() -> None:
    """An English request stays English even if it names a German exercise."""
    from app.services.answer_stream import FINAL_RESPONSE_LANGUAGE_RULE

    assert "latest QUESTION" in FINAL_RESPONSE_LANGUAGE_RULE
    assert '"Aufgabe 13.1"' in FINAL_RESPONSE_LANGUAGE_RULE
    assert "every language and writing system" in FINAL_RESPONSE_LANGUAGE_RULE
    assert "actual instruction/request" in FINAL_RESPONSE_LANGUAGE_RULE
    assert "Never switch to the source language" in FINAL_RESPONSE_LANGUAGE_RULE


def test_professor_solution_followup_targets_visible_pdf() -> None:
    from app.services.answer_stream import (
        _detect_question_language,
        _exact_exercise_overlay,
        _is_deictic_question,
        _language_rewrite_followup_overlay,
        _latest_question_language_overlay,
    )

    assert _is_deictic_question(
        "I don't understand how the Aufgabe was answered. Please explain in detail how the prof answered it"
    )
    assert _is_deictic_question("Walk me through the solution shown here")
    assert _is_deictic_question("now correct Aufgabe 13.2")
    overlay = _latest_question_language_overlay("now correct Aufgabe 13.2")
    assert "whatever the language is" in overlay
    assert "Aufgabe" in overlay
    assert "mandatory): English" not in overlay
    assert "mandatory): German" not in overlay
    exercise = _exact_exercise_overlay("now correct Aufgabe 13.2", has_visible_context=True)
    assert "exercise 13.2" in exercise
    assert "Source 0" in exercise
    assert "other exercise number" in exercise
    assert _detect_question_language("how did the prof find the value for Aufgabe13.6").name == "ENGLISH"
    assert _detect_question_language("Explique-moi la tâche 13.6").name == "FRENCH"
    assert _detect_question_language("اشرح لي كيف وجد الأستاذ القيمة").name == "ARABIC"
    followup = _language_rewrite_followup_overlay(
        "in english pls",
        [
            {"role": "user", "text": "how did the prof find the value for Aufgabe13.6"},
            {"role": "assistant", "text": "Die Rechnung ergibt 15 s."},
        ],
    )
    assert "previous assistant answer in English" in followup
    assert "Do not ask which task" in followup


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


# ── Problem Solver helpers ──────────────────────────────────────────────────


def test_problem_solver_overlay_check_mode_requires_student_work() -> None:
    """Check mode should not quietly become a full-solution prompt when
    the student did not paste an attempt."""
    from app.services.answer_stream import _problem_solver_overlay

    overlay = _problem_solver_overlay("check", {"mode": "check", "problem": "Find F"})
    assert "Selected mode: CHECK MY WORK" in overlay
    assert "no student work attached" in overlay
    assert "identify the first incorrect or risky step" in overlay.lower()


def test_problem_solver_user_block_keeps_problem_and_student_work_separate() -> None:
    """The retrieval query can stay focused on the problem while the LLM
    still receives the optional attempt as a separate section."""
    from app.services.answer_stream import _problem_solver_user_block

    block = _problem_solver_user_block({
        "mode": "check",
        "problem": "Given R=10 Ohm and U=5 V, find I.",
        "studentWork": "I = U * R = 50 A",
    })
    assert "Problem statement:" in block
    assert "Given R=10 Ohm" in block
    assert "Student work to check:" in block
    assert "I = U * R = 50 A" in block


def test_visible_pdf_context_promotes_retrieval_strength() -> None:
    """If the frontend sends visible PDF text, the stream prompt can answer
    from it even when vector retrieval missed the page."""
    from app.services.answer_stream import _effective_strength_with_open_context

    assert _effective_strength_with_open_context("weak", True) == "strong"
    assert _effective_strength_with_open_context("none", True) == "strong"
    assert _effective_strength_with_open_context("weak", False) == "weak"


def test_compact_exercise_correction_resolves_against_recent_context() -> None:
    from app.services.answer_stream import _resolved_exercise_number

    turns = [
        {"role": "user", "text": "How did the professor solve Aufgabe 13.6?"},
        {"role": "assistant", "text": "For Aufgabe 13.6, the marked result is 114 s."},
    ]
    assert _resolved_exercise_number("no it's Aufgabe 1306", turns) == "13.6"


def test_exact_exercise_overlay_forbids_number_substitution() -> None:
    from app.services.answer_stream import _exact_exercise_overlay

    overlay = _exact_exercise_overlay(
        "How did the professor get Aufgabe 13.6?",
        has_visible_context=True,
        previous_turns=[],
    )
    assert "exercise 13.6" in overlay
    assert "not an alias" in overlay
    assert "differently numbered exercise" in overlay


def test_default_explain_mode_is_conversational_and_interactive() -> None:
    from app.services.answer import pick_system_prompt

    prompt, _ = pick_system_prompt("I don't understand this step", "strong", [])
    assert "CONVERSATIONAL EXPLAIN" in prompt
    assert "recent chat history actively" in prompt
    assert "ONE short, topic-specific check" in prompt
    assert "Never withhold an answer" in prompt


# ── Cache key fold-in for previousTurns ─────────────────────────────────────


def test_open_file_image_parts_builds_visible_page_image_block() -> None:
    """Scanned/weak OCR pages can be attached as Source 0 image context."""
    from app.services.answer_stream import _open_file_image_parts

    parts = _open_file_image_parts([
        {"mediaType": "image/jpeg", "data": "abc123==", "page": 4},
    ])

    assert parts == [{
        "type": "image_url",
        "image_url": {"url": "data:image/jpeg;base64,abc123=="},
    }]


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

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
        _is_user_correction,
        _user_correction_overlay,
    )

    assert _is_deictic_question(
        "I don't understand how the Aufgabe was answered. Please explain in detail how the prof answered it"
    )
    assert _is_deictic_question("Walk me through the solution shown here")
    assert _is_deictic_question("now correct Aufgabe 13.2")
    assert _is_deictic_question("not the professor marked 11")
    assert _is_user_correction("not the professor marked 11")
    assert not _is_user_correction("What did the professor mark?")
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
    correction = _user_correction_overlay(
        "not the professor marked 11",
        has_visible_context=True,
        has_history=True,
    )
    assert "not asking a new course question" in correction
    assert "Do not switch to another exercise" in correction
    assert "[Source 0]" in correction
    assert _detect_question_language("not the professor marked 11").name == "ENGLISH"


# ── QA J1: course-faithfulness / rejecting a correct student correction ────
# Repro (report-2026-10-12.md §23): a Festlager/Einspannung reaction-type
# question was answered wrong, then the student's correct quotation from the
# course PDF ("But page 3 says a Festlager only has...") was dismissed. Two
# independent gaps caused this: (1) the correction-opener regex missed "but"/
# "however"/"isn't" etc., so the correction overlay never fired; (2) no rule
# told the model a document's own definition outranks its generic/training
# knowledge of the same term. Both are fixed generically, not by hardcoding
# anything statics-specific.


def test_user_correction_detector_catches_common_openers_not_just_no_wrong() -> None:
    from app.services.answer_stream import _is_user_correction

    # The exact J1 repro phrasing, and other common correction openers that
    # the original "no/not/wrong/actually" word-list missed entirely.
    assert _is_user_correction(
        "But page 3 says a Festlager only has horizontal and vertical "
        "reaction force, no moment. Isn't A a Festlager, not a fixed support?"
    )
    assert _is_user_correction("However, the document defines it differently.")
    assert _is_user_correction("Isn't that a Festlager, not a fixed support?")
    assert _is_user_correction("Wait, that doesn't match what the PDF says.")
    assert _is_user_correction("Aber auf Seite 3 steht etwas anderes.")
    # An ordinary new question using the same words mid-sentence is NOT a
    # correction opener (anchored at the start, so false positives stay rare).
    assert not _is_user_correction("What is the difference between a Festlager and an Einspannung?")


def test_user_correction_overlay_points_at_all_evidence_not_just_visible_page() -> None:
    """The quoted definition may live on a retrieved page, not the one
    currently visible — the overlay must not tell the model to only
    re-check Source 0 when the disputed claim could be in COURSE CONTEXT."""
    from app.services.answer_stream import _user_correction_overlay

    overlay = _user_correction_overlay(
        "But page 3 says a Festlager has no moment reaction.",
        has_visible_context=True,
        has_history=True,
    )
    assert "COURSE CONTEXT" in overlay
    assert "different page than the one currently visible" in overlay
    assert "explicitly acknowledge your previous answer was wrong" in overlay
    assert "never treat a student's quotation as automatically true without checking" in overlay

    overlay_no_visible = _user_correction_overlay(
        "But the document defines it differently.",
        has_visible_context=False,
        has_history=True,
    )
    assert "COURSE CONTEXT" in overlay_no_visible


def test_evidence_priority_rules_cover_definitional_conflicts_not_just_numbers() -> None:
    """AUTHORITATIVE-SOURCE CONFLICT POLICY already covered conflicting numeric
    givens; it said nothing about a term's DEFINITION conflicting with the
    model's generic/training knowledge of that term — exactly what let the
    Festlager/Einspannung mix-up survive despite correct retrieved evidence."""
    from app.services.answer_stream import EVIDENCE_PRIORITY_RULES

    assert "DOCUMENT DEFINITIONS OUTRANK GENERAL KNOWLEDGE" in EVIDENCE_PRIORITY_RULES
    assert "state what THAT DOCUMENT says" in EVIDENCE_PRIORITY_RULES
    assert "AUTHORITATIVE-SOURCE CONFLICT POLICY" in EVIDENCE_PRIORITY_RULES
    assert "UNTRUSTED DOCUMENT DATA" in EVIDENCE_PRIORITY_RULES


def test_statics_support_rule_reaches_the_course_grounded_streaming_path() -> None:
    """Live re-verification (2026-10-16) of the merged J1/F6 fix found
    EVIDENCE_PRIORITY_RULES alone insufficient: with QA-Statik.pdf uploaded and
    page 3's own "Festlager: horizontale und vertikale Lagerkraft" definition
    cited in the retrieved sources, the model still answered "support A is a
    fixed support... does have a moment reaction" — a false-friend mistranslation
    (German "fest" -> English "fixed support") the model doesn't recognise as a
    conflict with the document, so the generic "trust the document" rule never
    engages. STATICS_SUPPORT_RULE already prevents this on the non-grounded
    chat.py/general_answer.py paths (test_chat_routing.py); it must also reach
    this course-grounded streaming path, where J1 actually reproduces live."""
    from app.services.answer_stream import STATICS_SUPPORT_RULE

    assert "Festlager" in STATICS_SUPPORT_RULE
    assert "NO moment" in STATICS_SUPPORT_RULE
    assert "Einspannung" in STATICS_SUPPORT_RULE


def test_user_correction_overlay_does_not_blindly_trust_the_student() -> None:
    """Directive requirement: no blanket rule that all user quotations are
    automatically true — the model must still check before agreeing."""
    from app.services.answer_stream import _user_correction_overlay

    overlay = _user_correction_overlay(
        "No, that's not what the document says.",
        has_visible_context=True,
        has_history=True,
    )
    assert "does not support the student's quotation" in overlay
    assert "without checking it against the evidence" in overlay


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


def test_math_prompt_distinguishes_sweep_moves_from_total_passes() -> None:
    from app.services.answer import _SYSTEM_PROMPT_MATH

    assert "number of additional moves" in _SYSTEM_PROMPT_MATH
    assert "total number of passes/positions" in _SYSTEM_PROMPT_MATH
    assert "m=10$ moves but $n=11$ passes" in _SYSTEM_PROMPT_MATH


def test_visible_page_skips_redundant_retrieved_figure_render() -> None:
    from app.services.answer_stream import _should_attach_retrieved_figure

    assert not _should_attach_retrieved_figure(
        will_attach_figure=True, has_open_image=True, deictic=True,
    )
    assert _should_attach_retrieved_figure(
        will_attach_figure=True, has_open_image=False, deictic=True,
    )
    assert _should_attach_retrieved_figure(
        will_attach_figure=True, has_open_image=True, deictic=False,
    )


def test_cached_answer_language_must_match_latest_question() -> None:
    from app.services.answer_stream import _answer_matches_question_language

    question = "How do I answer Aufgabe 13.9?"
    english = "Here is how to answer the exercise: first identify the required value, then substitute the given data."
    german = "So beantwortest du die Aufgabe: Bestimme zuerst den gesuchten Wert und setze dann die gegebenen Daten ein."
    assert _answer_matches_question_language(question, english)
    assert not _answer_matches_question_language(question, german)


def test_visual_source_labels_do_not_trigger_wrong_language_gate() -> None:
    from app.services.answer_stream import answer_matches_resolved_language

    answer = (
        "1. Auswerferseite — This is the side where the moulded part is ejected.\n"
        "2. Düsenseite — This side faces the injection nozzle.\n"
        "3. Schließzylinder — This cylinder closes and clamps the mould."
    )
    assert answer_matches_resolved_language(
        answer,
        "en",
        preserve_source_labels=True,
    )


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


# ── general-knowledge-first, web search only as the actual last resort ─────
#
# Priority is course docs -> general knowledge -> web search. The search
# itself only runs when _general_knowledge_likely_insufficient() says this
# particular question needs it — NOT unconditionally whenever retrieval
# found nothing, which would make search happen BEFORE general knowledge
# got a chance instead of only as its fallback.


def _mock_openai_chat_response(monkeypatch, module, content: str) -> None:
    """Patch module.get_openai_client() to return a fake client whose
    chat.completions.create(...) always returns `content` as the message."""
    class _FakeMessage:
        def __init__(self, content: str) -> None:
            self.content = content

    class _FakeChoice:
        def __init__(self, content: str) -> None:
            self.message = _FakeMessage(content)

    class _FakeResponse:
        def __init__(self, content: str) -> None:
            self.choices = [_FakeChoice(content)]

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    return _FakeResponse(content)

    monkeypatch.setattr(module, "get_openai_client", lambda: _FakeClient())


def test_general_knowledge_check_says_no_for_ordinary_academic_question(monkeypatch) -> None:
    from app.services import answer_stream, openai_client

    # _general_knowledge_likely_insufficient does a LOCAL
    # `from .openai_client import get_openai_client` — the name resolves
    # fresh from the openai_client module at call time, so that's what must
    # be patched, not answer_stream's own namespace.
    _mock_openai_chat_response(monkeypatch, openai_client, "NO")
    assert answer_stream._general_knowledge_likely_insufficient("What is Newton's second law?") is False


def test_general_knowledge_check_says_yes_for_current_information_question(monkeypatch) -> None:
    from app.services import answer_stream, openai_client

    _mock_openai_chat_response(monkeypatch, openai_client, "YES")
    assert answer_stream._general_knowledge_likely_insufficient("What is the latest version of Python?") is True


def test_general_knowledge_check_defaults_to_no_web_search_on_failure(monkeypatch) -> None:
    """A classification failure must fail toward the cheaper, already-
    working path (general knowledge only), not toward extra search cost."""
    from app.services import answer_stream, openai_client

    def _boom():
        raise RuntimeError("api down")

    monkeypatch.setattr(openai_client, "get_openai_client", _boom)
    assert answer_stream._general_knowledge_likely_insufficient("anything") is False


def test_web_search_last_resort_skips_search_when_general_knowledge_suffices(monkeypatch) -> None:
    """The common case: course retrieval found nothing, but this is an
    ordinary question general knowledge covers fine — no search call at all."""
    from app.services import answer_stream, web_answer

    monkeypatch.setattr(answer_stream, "_general_knowledge_likely_insufficient", lambda q: False)
    called = []
    monkeypatch.setattr(
        web_answer, "generate_web_answer",
        lambda *a, **k: called.append(1) or {"answer": "x", "model": "m", "webSources": []},
    )

    text, sources = answer_stream._web_search_last_resort("What is Newton's second law?", user_id=None)

    assert text == ""
    assert sources == []
    assert called == []  # generate_web_answer must never have been invoked


def test_web_search_last_resort_returns_text_and_sources_on_success(monkeypatch) -> None:
    from app.services import answer_stream, web_answer

    monkeypatch.setattr(answer_stream, "_general_knowledge_likely_insufficient", lambda q: True)
    monkeypatch.setattr(
        web_answer,
        "generate_web_answer",
        lambda question, *, query, max_tokens=1400: {
            "answer": "The current version is 3.2, released last month.",
            "model": "gpt-4.1-mini",
            "webSources": [{"title": "Official docs", "url": "https://example.com/docs"}],
            "promptTokens": 120,
            "completionTokens": 40,
        },
    )
    recorded: list[dict] = []
    monkeypatch.setattr(
        answer_stream, "record_usage", lambda **kwargs: recorded.append(kwargs)
    )

    text, sources = answer_stream._web_search_last_resort("what's the latest version?", user_id="u1")

    assert text == "The current version is 3.2, released last month."
    assert sources == [{"title": "Official docs", "url": "https://example.com/docs"}]
    assert recorded and recorded[0]["feature"] == "ask_stream_web_fallback"
    assert recorded[0]["model"] == "gpt-4.1-mini"


def test_web_search_last_resort_is_empty_when_search_unavailable(monkeypatch) -> None:
    """generate_web_answer's own 'unavailable' sentinel has model=None —
    must not be mistaken for a real result."""
    from app.services import answer_stream, web_answer

    monkeypatch.setattr(answer_stream, "_general_knowledge_likely_insufficient", lambda q: True)
    monkeypatch.setattr(
        web_answer,
        "generate_web_answer",
        lambda question, *, query, max_tokens=1400: {
            "answer": web_answer.INTERNET_UNAVAILABLE_MESSAGE,
            "model": None,
            "webSources": [],
            "promptTokens": None,
            "completionTokens": None,
        },
    )
    text, sources = answer_stream._web_search_last_resort("anything", user_id=None)
    assert text == ""
    assert sources == []


def test_web_search_last_resort_swallows_exceptions(monkeypatch) -> None:
    """A real network/API failure must degrade to 'no web context' rather
    than blocking or crashing the fallback answer."""
    from app.services import answer_stream, web_answer

    monkeypatch.setattr(answer_stream, "_general_knowledge_likely_insufficient", lambda q: True)

    def _boom(question, *, query, max_tokens=1400):
        raise RuntimeError("network down")

    monkeypatch.setattr(web_answer, "generate_web_answer", _boom)
    text, sources = answer_stream._web_search_last_resort("anything", user_id=None)
    assert text == ""
    assert sources == []


def test_workspace_question_path_does_not_crash_on_unbound_academic_intent() -> None:
    """App/workspace questions skip the academic_intent classification (it's
    only computed on the RAG branch), but it was still read unconditionally
    later to decide is_exam_request — an UnboundLocalError on every single
    app/workspace question in production. Reproduced from real server logs
    (request_id ncb_msg_mtihivmy_aazd611s, 2026-09-01)."""
    from app.services.answer_stream import stream_answer

    gen = stream_answer(
        question="what's the open document and what does it contain?",
        chunks=[],
        doc_names={},
        workspace_question=True,
    )
    first_chunk = next(gen)
    assert isinstance(first_chunk, bytes)


# ── Intent-routing: a visible page's own wording must not override the
# student's actual request ──────────────────────────────────────────────
#
# The visible-page slice is blended into a LOCAL "routing_question" so the
# chunk/math-context signals can see it, but that same blended string was
# also handed to classify_academic_intent — whose keyword regexes (quiz,
# summary, comparison, ...) are meant to read the STUDENT's own instruction,
# not arbitrary page text. A lecture slide's own "Overview"/"Summary"
# heading could therefore silently flip an explicit "explain the
# illustration" request into AcademicIntent.COURSE_SUMMARY, producing a
# generic summary instead of the requested explanation.


def test_visible_page_heading_does_not_override_explicit_explain_request(monkeypatch) -> None:
    from app.services import answer, answer_stream
    from app.services.answer_intent import AcademicIntent

    original = answer.intent_style_instruction
    captured: list = []

    def _spy(intent, *args, **kwargs):
        captured.append(intent)
        return original(intent, *args, **kwargs)

    monkeypatch.setattr(answer, "intent_style_instruction", _spy)

    # The visible page itself contains a "Summary" heading elsewhere on the
    # slide — incidental to the student's actual, explicit request below.
    open_ctx = (
        "Chapter 4 — Overview\n\n"
        "Figure 4.2 shows a free-body diagram of the beam.\n\n"
        "Summary: reaction forces balance applied loads.\n"
    )
    gen = answer_stream.stream_answer(
        question="Explain the illustration on this page",
        chunks=[],
        doc_names={},
        open_file_context=open_ctx,
    )
    next(gen)

    assert captured, "intent_style_instruction was never called"
    assert captured[0] == AcademicIntent.CONCEPTUAL_EXPLANATION


def test_visible_page_heading_does_not_override_explicit_solve_request(monkeypatch) -> None:
    """Same contamination risk for a step-by-step solve request sharing a
    page with an end-of-chapter formula recap."""
    from app.services import answer, answer_stream
    from app.services.answer_intent import AcademicIntent

    original = answer.intent_style_instruction
    captured: list = []

    def _spy(intent, *args, **kwargs):
        captured.append(intent)
        return original(intent, *args, **kwargs)

    monkeypatch.setattr(answer, "intent_style_instruction", _spy)

    open_ctx = (
        "Zusammenfassung: wichtige Formeln dieses Kapitels.\n\n"
        "Aufgabe 4.2: Bestimme die Reaktionskraft am Lager A.\n"
    )
    gen = answer_stream.stream_answer(
        question="Help me solve this exercise step by step",
        chunks=[],
        doc_names={},
        open_file_context=open_ctx,
    )
    next(gen)

    assert captured, "intent_style_instruction was never called"
    assert captured[0] == AcademicIntent.MATH_PROBLEM


def test_quiz_request_is_not_hijacked_by_page_summary_heading(monkeypatch) -> None:
    """A genuine quiz request must stay QUIZ_GENERATION even though the
    visible page carries a 'Summary' heading alongside the quizzable
    material."""
    from app.services import answer, answer_stream
    from app.services.answer_intent import AcademicIntent

    original = answer.intent_style_instruction
    captured: list = []

    def _spy(intent, *args, **kwargs):
        captured.append(intent)
        return original(intent, *args, **kwargs)

    monkeypatch.setattr(answer, "intent_style_instruction", _spy)

    open_ctx = "Summary: key points of chapter 4 on torsion and shear.\n"
    gen = answer_stream.stream_answer(
        question="Quiz me on this topic",
        chunks=[],
        doc_names={},
        open_file_context=open_ctx,
    )
    next(gen)

    assert captured, "intent_style_instruction was never called"
    assert captured[0] == AcademicIntent.QUIZ_GENERATION


def test_genuine_summary_request_still_classifies_as_summary(monkeypatch) -> None:
    """The fix must not overcorrect: a real 'summarize'/'explain in detail'
    request from the student still gets the matching template."""
    from app.services import answer, answer_stream
    from app.services.answer_intent import AcademicIntent

    original = answer.intent_style_instruction
    captured: list = []

    def _spy(intent, *args, **kwargs):
        captured.append(intent)
        return original(intent, *args, **kwargs)

    monkeypatch.setattr(answer, "intent_style_instruction", _spy)

    gen = answer_stream.stream_answer(
        question="Summarize this page",
        chunks=[],
        doc_names={},
        open_file_context="Figure 4.2 shows a free-body diagram of the beam.\n",
    )
    next(gen)

    assert captured, "intent_style_instruction was never called"
    assert captured[0] == AcademicIntent.COURSE_SUMMARY


def test_followup_detail_request_is_not_hijacked_by_page_summary_heading(monkeypatch) -> None:
    """The contamination risk applies on every call, not just a fresh
    question — a short follow-up ("go over that step again") referencing a
    prior solve exchange must not be reclassified as COURSE_SUMMARY just
    because the still-visible page carries its own 'Summary' heading."""
    from app.services import answer, answer_stream
    from app.services.answer_intent import AcademicIntent

    original = answer.intent_style_instruction
    captured: list = []

    def _spy(intent, *args, **kwargs):
        captured.append(intent)
        return original(intent, *args, **kwargs)

    monkeypatch.setattr(answer, "intent_style_instruction", _spy)

    open_ctx = (
        "Summary: key reactions at supports A and B.\n\n"
        "Aufgabe 4.2: Bestimme die Reaktionskraft am Lager A.\n"
    )
    gen = answer_stream.stream_answer(
        question="Can you go over that step again?",
        chunks=[],
        doc_names={},
        open_file_context=open_ctx,
        previous_turns=[
            {"role": "user", "text": "Help me solve Aufgabe 4.2 step by step"},
            {"role": "assistant", "text": "Step 1: sum moments about A..."},
        ],
    )
    next(gen)

    assert captured, "intent_style_instruction was never called"
    assert captured[0] == AcademicIntent.GENERAL_COURSE_QA


def test_prohibition_and_depth_reach_the_actual_model_call_boundary(monkeypatch) -> None:
    """P1 follow-up verification: not a classify_academic_intent() unit test —
    this drives the real stream_answer() generator all the way to the actual
    `client.chat.completions.create(...)` call and inspects the literal
    `messages` kwarg that would be sent to the model, using the exact
    confirmed production repro (BWL_gesamt page 6: a page whose own text has
    a literal "Zusammenfassung" heading, student explicitly says explain in
    detail / do not summarize)."""
    from app.services import answer_stream

    captured_calls: list = []

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_calls.append(kwargs)
                    return []  # empty stream: zero chunks, loop body never runs

    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: _FakeClient())

    page_text = (
        "Wirtschaft und Oekonomie\n\n"
        "Der Begriff Wirtschaft leitet sich vom althochdeutschen Wort 'wirt' ab, "
        "waehrend Oekonomie auf die griechischen Wurzeln oikos (Haus) und nemein "
        "(verwalten) zurueckgeht.\n\n"
        "## Zusammenfassung\n"
        "Wirtschaft bezeichnet die Gesamtheit aller Einrichtungen und Handlungen, "
        "die der Deckung menschlicher Beduerfnisse dienen.\n"
    )
    question = "Explain the concept on this page in detail. Do not summarize it."
    gen = answer_stream.stream_answer(
        question=question,
        chunks=[],
        doc_names={},
        open_file_context=page_text,
    )
    for _ in gen:
        pass  # drive to completion; the fake stream has nothing to yield

    assert len(captured_calls) == 1, "expected one answer-model call"
    messages = captured_calls[0]["messages"]
    system_message = next(m["content"] for m in messages if m["role"] == "system")
    user_message = next(m["content"] for m in messages if m["role"] == "user")
    assert isinstance(system_message, str) and isinstance(user_message, str)

    # (1) Primary task is explain, not summarize: no instruction says to
    # treat this as a summary request.
    assert "Treat this as a summary request" not in system_message
    # (2) + (3) The prohibition is explicitly preserved as a high-priority
    # instruction, independent of which intent the request resolved to.
    assert "prohibited summarizing" in system_message
    assert "Do NOT include a" in system_message
    # (4) No system/task instruction anywhere tells the model to summarize —
    # already covered directly by the "Treat this as a summary request" check
    # above (that's the literal instruction text the COURSE_SUMMARY branch
    # injects); the base template's own unrelated, generic uses of the word
    # "summary" elsewhere are not a defect and are not asserted against here.
    # (5) The page's own CONTENT (the actual sentence under its
    # "Zusammenfassung" heading) remains SOURCE material, never promoted into
    # an instruction — the word "Zusammenfassung" itself legitimately also
    # appears in the generic prohibition instruction above (quoting what NOT
    # to title a heading), so the real test is the page's specific wording,
    # not the bare word.
    page_summary_sentence = "Wirtschaft bezeichnet die Gesamtheit aller Einrichtungen und Handlungen"
    assert page_summary_sentence not in system_message
    # (6) The correct page context IS available for grounding, and the raw
    # student instruction reaches the model verbatim (not paraphrased away).
    assert page_summary_sentence in user_message
    assert "Zusammenfassung" in user_message
    assert "Wirtschaft" in user_message
    assert question in user_message


def _run_stream_answer_and_capture_system_message(monkeypatch, question: str, page_text: str) -> str:
    """Shared helper for the final_negation_reminder boundary tests below —
    same fake-client technique as test_prohibition_and_depth_reach_the_actual_
    model_call_boundary above, factored out so each test states only what
    differs (the question)."""
    from app.services import answer_stream

    captured_calls: list = []

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_calls.append(kwargs)
                    return []

    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: _FakeClient())

    gen = answer_stream.stream_answer(
        question=question,
        chunks=[],
        doc_names={},
        open_file_context=page_text,
    )
    for _ in gen:
        pass

    assert len(captured_calls) == 1, "expected one answer-model call"
    messages = captured_calls[0]["messages"]
    return next(m["content"] for m in messages if m["role"] == "system")


def _run_stream_answer_and_capture_both_messages(monkeypatch, question: str, page_text: str) -> tuple[str, str]:
    """Same technique as the helper above, but also returns the USER message
    — needed for final_negation_user_reminder, which is appended there, not
    to the system prompt."""
    from app.services import answer_stream

    captured_calls: list = []

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_calls.append(kwargs)
                    return []

    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: _FakeClient())

    gen = answer_stream.stream_answer(
        question=question,
        chunks=[],
        doc_names={},
        open_file_context=page_text,
    )
    for _ in gen:
        pass

    assert len(captured_calls) == 1, "expected one answer-model call"
    messages = captured_calls[0]["messages"]
    system_message = next(m["content"] for m in messages if m["role"] == "system")
    user_message = next(m["content"] for m in messages if m["role"] == "user")
    assert isinstance(user_message, str), "expected a plain text user message (no image parts in this test)"
    return system_message, user_message


_PAGE6_TEXT = (
    "Wirtschaft und Oekonomie\n\n"
    "Der Begriff Wirtschaft leitet sich vom althochdeutschen Wort 'wirt' ab, "
    "waehrend Oekonomie auf die griechischen Wurzeln oikos (Haus) und nemein "
    "(verwalten) zurueckgeht.\n\n"
    "## Zusammenfassung\n"
    "Wirtschaft bezeichnet die Gesamtheit aller Einrichtungen und Handlungen, "
    "die der Deckung menschlicher Beduerfnisse dienen.\n"
)


def test_final_reminder_is_positioned_after_the_later_generic_structure_rules(monkeypatch) -> None:
    """Root-cause regression (PR #27 follow-up): live acceptance testing found
    the model ignoring the mid-prompt prohibition because several more
    generic, later-appended structure rules (table layout, the "use headings"
    response-structure rule, the grounding-policy line) sat AFTER it, diluting
    its priority. This asserts final_negation_reminder's text is the LAST
    thing in the system prompt, strictly after all three of those blocks —
    not just present somewhere."""
    question = "Explain the concept on this page in detail. Do not summarize it."
    system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)

    table_layout_pos = system_message.index("ANSWER LAYOUT.")
    response_structure_pos = system_message.index("RESPONSE STRUCTURE")
    grounding_policy_pos = system_message.index("GROUNDING POLICY:")
    final_reminder_pos = system_message.index("FINAL REMINDER")

    assert final_reminder_pos > table_layout_pos
    assert final_reminder_pos > response_structure_pos
    assert final_reminder_pos > grounding_policy_pos
    # And it must actually be the tail of the prompt, not just after those
    # markers but followed by yet more instructions that could dilute it again.
    assert system_message.rstrip().endswith(
        "Keep every citation and sourced detail already in the answer — "
        "only the closing recap is forbidden."
    )


def test_final_reminder_closes_the_near_miss_wording_gap(monkeypatch) -> None:
    """The live failures were specifically headings like "Summary of
    Development" / "Summary of Evolution" (not the bare "Summary" the
    original instruction named) and untitled recap paragraphs. The reminder
    must explicitly name those variants, not just repeat the original
    instruction's narrower wording."""
    question = "Explain the concept on this page in detail. Do not summarize it."
    system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)

    final_reminder_start = system_message.index("FINAL REMINDER")
    reminder_tail = system_message[final_reminder_start:]
    assert "Summary of ..." in reminder_tail
    assert "Recap" in reminder_tail
    assert "Takeaways" in reminder_tail
    assert "Conclusion" in reminder_tail
    assert "untitled" in reminder_tail


def test_plain_explain_request_gets_no_final_reminder(monkeypatch) -> None:
    """Control: 'Explain ... in detail' with NO prohibition must remain
    completely unrestricted — no FINAL REMINDER block at all."""
    question = "Explain the concept on this page in detail."
    system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)
    assert "FINAL REMINDER" not in system_message


def test_explicit_summary_request_still_permits_and_requests_summarization(monkeypatch) -> None:
    """Control: an explicit, non-prohibited summarize request must still get
    the normal summary-task instruction and must NOT get the no-summary
    reminder — the fix must not become a blanket anti-summary rule."""
    question = "Summarize the concept on this page briefly."
    system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)
    assert "FINAL REMINDER" not in system_message
    assert "Treat this as a summary request" in system_message


def test_final_reminder_fires_for_the_same_prohibition_in_german(monkeypatch) -> None:
    """The prohibition — and this reminder — must work in German, not just
    English, since Minallo answers in the question's language."""
    question = "Erkläre das Konzept auf dieser Seite im Detail. Fasse es nicht zusammen."
    system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)
    assert "FINAL REMINDER" in system_message
    final_reminder_start = system_message.index("FINAL REMINDER")
    assert final_reminder_start > system_message.index("GROUNDING POLICY:")


def test_final_reminder_preserves_grounding_and_citation_rules(monkeypatch) -> None:
    """The reminder must be purely additive: it must not remove or weaken the
    existing citation/grounding rules elsewhere in the prompt."""
    question = "Explain the concept on this page in detail. Do not summarize it."
    system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)
    assert "[Source N]" in system_message
    assert "Use ONLY the context" in system_message


def test_quiz_and_hint_requests_without_a_summary_prohibition_are_unaffected(monkeypatch) -> None:
    """Deliverable #4.7: existing quiz/hint behaviour must be unchanged by
    this fix — it is scoped strictly to a detected summary prohibition."""
    for question in ("Quiz me on this chapter.", "Give me a hint for this problem."):
        system_message = _run_stream_answer_and_capture_system_message(monkeypatch, question, _PAGE6_TEXT)
        assert "FINAL REMINDER" not in system_message


def test_final_no_summary_check_reaches_the_user_message_after_course_context(monkeypatch) -> None:
    """final_negation_user_reminder is the second half of the fix: the same
    detected prohibition, repeated at the true end of the USER message
    (mirroring the existing FINAL LANGUAGE CHECK pattern) because that is
    closer to generation than anything in the system prompt. Must land AFTER
    COURSE CONTEXT, not merely be present somewhere."""
    question = "Explain the concept on this page in detail. Do not summarize it."
    _, user_message = _run_stream_answer_and_capture_both_messages(monkeypatch, question, _PAGE6_TEXT)

    assert "FINAL NO-SUMMARY CHECK" in user_message
    course_context_pos = user_message.index("COURSE CONTEXT:")
    reminder_pos = user_message.index("FINAL NO-SUMMARY CHECK")
    assert reminder_pos > course_context_pos
    assert user_message.rstrip().endswith(
        "delete that closing section and stop after the last new point instead."
    )


def test_final_no_summary_check_absent_without_a_prohibition(monkeypatch) -> None:
    """Control: no prohibition detected → no user-message reminder either,
    for both an unrestricted explain and a permitted summarize request."""
    for question in (
        "Explain the concept on this page in detail.",
        "Summarize the concept on this page briefly.",
    ):
        _, user_message = _run_stream_answer_and_capture_both_messages(monkeypatch, question, _PAGE6_TEXT)
        assert "FINAL NO-SUMMARY CHECK" not in user_message


def _run_stream_answer_with_figure_and_capture_messages(
    monkeypatch, question: str, page_text: str,
) -> tuple[str, str, int]:
    """Same technique as _run_stream_answer_and_capture_both_messages, plus
    forcing the figure-attach branch (_should_attach_retrieved_figure /
    _figure_page_image_parts) regardless of the real retrieval/math-mode
    heuristics that normally gate it — those heuristics aren't what this
    boundary test is checking; only the resulting user_message ORDER is.
    Returns (system_message, user_message_text, image_part_count)."""
    from app.services import answer_stream

    captured_calls: list = []

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_calls.append(kwargs)
                    return []

    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: _FakeClient())
    monkeypatch.setattr(
        answer_stream, "_should_attach_retrieved_figure", lambda **kwargs: True,
    )
    monkeypatch.setattr(
        answer_stream,
        "_figure_page_image_parts",
        lambda used_chunks, max_images: [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,FAKE"}}
        ],
    )

    gen = answer_stream.stream_answer(
        question=question,
        chunks=[],
        doc_names={},
        open_file_context=page_text,
    )
    for _ in gen:
        pass

    assert len(captured_calls) == 1, "expected one answer-model call"
    messages = captured_calls[0]["messages"]
    system_message = next(m["content"] for m in messages if m["role"] == "system")
    user_content = next(m["content"] for m in messages if m["role"] == "user")
    assert isinstance(user_content, list), "figure attach must send image parts, not a bare string"
    text_parts = [p["text"] for p in user_content if p.get("type") == "text"]
    image_parts = [p for p in user_content if p.get("type") == "image_url"]
    assert len(text_parts) == 1
    return system_message, text_parts[0], len(image_parts)


def test_final_no_summary_check_is_the_true_tail_even_with_a_figure_attached(monkeypatch) -> None:
    """Closes the review finding: _FIGURE_READ_INSTRUCTION used to be appended
    AFTER final_negation_user_reminder, so a figure-attached request with an
    explicit no-summary prohibition (e.g. "explain this diagram in detail,
    don't summarize") lost the user-message reminder's tail position — the
    same dilution bug the reminder exists to fix, one level down. The reminder
    now moves past the figure-instruction block, so it must be the literal
    tail regardless of figure attachment, and the figure instruction, image
    attachment and page grounding must all still be present and intact."""
    question = "Explain the diagram on this page in detail. Do not summarize it."
    system_message, user_message, image_count = _run_stream_answer_with_figure_and_capture_messages(
        monkeypatch, question, _PAGE6_TEXT,
    )

    assert "EXERCISE FIGURE" in user_message
    assert "FINAL NO-SUMMARY CHECK" in user_message
    assert user_message.index("FINAL NO-SUMMARY CHECK") > user_message.index("EXERCISE FIGURE")
    assert user_message.rstrip().endswith(
        "delete that closing section and stop after the last new point instead."
    )

    # Figure/image attachment and page grounding remain intact.
    assert image_count == 1
    assert "Wirtschaft" in user_message
    assert "COURSE CONTEXT:" in user_message

    # The system-message reminder (the first half of the fix) is unaffected
    # by any of this — still the true tail of the system prompt.
    assert "FINAL REMINDER" in system_message


def test_figure_attached_request_without_prohibition_gets_no_reminder(monkeypatch) -> None:
    """Control: an ordinary figure-vision request with no summary prohibition
    must get the figure instruction but neither reminder."""
    question = "Explain the diagram on this page in detail."
    system_message, user_message, image_count = _run_stream_answer_with_figure_and_capture_messages(
        monkeypatch, question, _PAGE6_TEXT,
    )
    assert image_count == 1
    assert "EXERCISE FIGURE" in user_message
    assert "FINAL NO-SUMMARY CHECK" not in user_message
    assert "FINAL REMINDER" not in system_message

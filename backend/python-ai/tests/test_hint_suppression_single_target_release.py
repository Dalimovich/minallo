"""Hint-suppression fix — real SSE-level proof that a single-target
restricted policy ("give me a hint for 5b, but don't reveal the final
answer") actually delivers a clean, policy-compliant draft to the
student, instead of discarding it for the generic withheld message.

Background (see app/services/answer_release_validator.py's module
docstring "Hint-suppression fix" section and app/routers/stream.py
around the ``policy_has_release_restriction:`` branch): before this
fix, ``enforce_release_policy``'s unconditional whole-response withhold
ran for EVERY restricted policy, single-target or not — so a student
who asked for a hint while explicitly saying "don't give me the
answer" compiled to exactly one Action (one target, no cross-target
ambiguity), the model correctly produced a clean hint with no leaked
result, and the gate threw it away anyway because it never looked at
the scan result for its withhold decision. ``enforce_release_policy_
per_target`` was already a no-op pass-through to that same unconditional
guard (Priority 2's "REVISED after further review"), so routing through
it changed nothing for this case either.

The fix (app/routers/stream.py): when ``execution_policy.actions`` has
at most one distinct ``target`` (guaranteed one compiled Action per
target by policy_compiler.compile_policy's ``merged_by_target`` dict),
dispatch to the NEW ``enforce_release_policy_single_target`` instead —
scan-conditioned, released unless the leak-pattern scan actually
matches. Two or more distinct targets still go through the untouched
``enforce_release_policy_per_target`` (unconditional withhold) exactly
as before (711907b1/954cc46f) — proven unregressed by this file's own
multi-target test and by every pre-existing mixed-permission test in
test_answer_release_sse_enforcement.py (unchanged, still passing).

Reuses test_answer_release_sse_enforcement.py's route-level harness
(_setup/_run/_restrictive_policy/_mixed_5a_permitted_5b_prohibited_
policy) rather than reinventing it — same mock set, same direct
``ask_stream_endpoint`` call + body_iterator drain."""

from __future__ import annotations

import asyncio

import pytest

from tests.test_answer_release_sse_enforcement import (
    DOCUMENT_ID,
    QUESTION,
    USER_ID,
    _mixed_5a_permitted_5b_prohibited_policy,
    _restrictive_policy,
    _run,
    _setup,
)


# ---------------------------------------------------------------------------
# Required test 1 — single-target hint request, clean draft, must be
# delivered (not replaced by the generic withheld message).
# ---------------------------------------------------------------------------

def test_single_target_hint_request_with_clean_draft_is_delivered(monkeypatch):
    draft_text = (
        "Think about which forces act on the beam at the support. "
        "What does Newton's second law tell you about the relationship "
        "between the net force and acceleration here? Try setting up "
        "the equation before computing anything."
    )
    conversation_id = "hint-suppression-clean-hint"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(
            stream, conversation_id=conversation_id,
            question="Give me a hint for Aufgabe 5b, but don't reveal the final answer.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"Newton" in body, body
    assert b'"releaseWithheld": false' in body
    assert b'"releaseWithheldReason": "no_match"' in body
    assert b'"code": "answer_release_restricted"' not in body
    assert b"withholding the final result" not in body
    del save_calls


# ---------------------------------------------------------------------------
# Required test 2 — "help me start without solving it" / first-step-only.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("question", [
    "Show me only the first step for Aufgabe 5b.",
    "Help me start Aufgabe 5b without solving it.",
])
def test_single_target_first_step_only_request_is_delivered(monkeypatch, question):
    draft_text = (
        "The first step is to draw the free-body diagram for the beam "
        "and identify every force acting at the support. Once you've "
        "done that, set up the equilibrium equation."
    )
    conversation_id = f"hint-suppression-first-step-{abs(hash(question))}"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id, question=question))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"free-body diagram" in body, body
    assert b'"releaseWithheld": false' in body
    assert b'"code": "answer_release_restricted"' not in body
    del save_calls


# ---------------------------------------------------------------------------
# Required test 3 — method explained, final numeric value withheld by the
# MODEL's own draft (not by the gate discarding a clean answer).
# ---------------------------------------------------------------------------

def test_single_target_method_only_request_is_delivered(monkeypatch):
    draft_text = (
        "Use the moment-balance method: sum the moments about the "
        "support to zero, isolate the unknown reaction force, then "
        "solve for it. I'll leave the final arithmetic to you."
    )
    conversation_id = "hint-suppression-method-only"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(
            stream, conversation_id=conversation_id,
            question="Explain the method, but let me calculate the final value.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"moment-balance method" in body, body
    assert b'"releaseWithheld": false' in body
    assert b'"code": "answer_release_restricted"' not in body
    del save_calls


# ---------------------------------------------------------------------------
# Required test 4 — German equivalents.
# ---------------------------------------------------------------------------

def test_single_target_german_hint_request_is_delivered(monkeypatch):
    draft_text = (
        "Denk daran, welche Kräfte am Lager auf den Balken wirken. "
        "Was sagt dir das zweite Newtonsche Gesetz über den "
        "Zusammenhang zwischen der resultierenden Kraft und der "
        "Beschleunigung?"
    )
    conversation_id = "hint-suppression-german-hint"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(
            stream, conversation_id=conversation_id,
            question="Gib mir einen Hinweis für Aufgabe 5b, aber verrate nicht die Lösung.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert "Newtonsche Gesetz".encode() in body, body
    assert b'"releaseWithheld": false' in body
    assert b'"code": "answer_release_restricted"' not in body
    del save_calls


def test_single_target_german_method_only_request_is_delivered(monkeypatch):
    draft_text = (
        "Benutze die Momentengleichung: Summiere die Momente um das "
        "Lager zu null und löse nach der unbekannten Lagerkraft auf. "
        "Die Zahlenrechnung überlasse ich dir."
    )
    conversation_id = "hint-suppression-german-method"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(
            stream, conversation_id=conversation_id,
            question="Erkläre die Methode, aber lass mich den Endwert selbst berechnen.",
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert "Momentengleichung".encode() in body, body
    assert b'"releaseWithheld": false' in body
    assert b'"code": "answer_release_restricted"' not in body
    del save_calls


# ---------------------------------------------------------------------------
# Required test 5 (adversarial backstop) — already proven by the existing,
# unmodified parametrize cases in test_answer_release_sse_enforcement.py's
# test_restricted_final_answer_never_reaches_the_sse_stream, which uses
# this exact same single-target _restrictive_policy() for all four of its
# remaining cases ("final answer is...", "Therefore F = 42 N.", a
# \boxed{...}, and a markdown result table). Not duplicated here. The
# "Therefore F = 42 N." case specifically only keeps passing because this
# fix ALSO added the "concluding_symbol_equals_number" leak pattern to
# _LEAK_PATTERNS in answer_release_validator.py — that pattern's own
# regression coverage lives there, exercised end-to-end via that test.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Required test 6 — multi-target regression proof, byte-for-bit unchanged.
# ---------------------------------------------------------------------------

def test_mixed_permission_multi_target_unregressed_even_with_clean_hint_text(monkeypatch):
    """The exact mixed-permission scenario ('full answer for 5a, hint for
    5b') but with text that reads EXACTLY like one of this file's clean,
    deliverable single-target hints — proving the dispatch in stream.py
    correctly keys off target COUNT, not text content: two distinct
    targets must still go through enforce_release_policy_per_target's
    unconditional whole-response withhold, never the new single-target
    scan-conditioned path, no matter how clean the draft looks."""
    draft_text = (
        "[[TARGET: 5a]]\n"
        "The first step is to draw the free-body diagram and sum the moments.\n"
        "[[TARGET: 5b]]\n"
        "Think about which forces act at the support.\n"
        "[[END]]\n"
    )
    conversation_id = "hint-suppression-mixed-unregressed"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"free-body diagram" not in body  # whole response withheld, even 5a's clean text
    assert b"Think about which forces" not in body
    assert b'"releaseWithheld": true' in body
    assert b'"releaseStructural": false' in body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls


# ---------------------------------------------------------------------------
# Required test 7 (cache-hit half) — a previously-released, already-gated
# single-target hint, replayed from cache, must still reach the student
# as itself (not re-withheld, not bypassed into something else). Needs
# stream.py's OWN module-level bindings of fetch_course_version_hash/
# lookup_answer patched directly (not app.services.cache's attributes —
# stream.py imports them by name at module load, same gotcha already
# documented in test_answer_release_sse_enforcement.py's _setup for
# retrieve_exercise_block), plus an open-context-free payload so the
# route's `cacheable` gate (stream.py's `cacheable = (...)`) is actually
# true, plus an explicit responseLanguage so the cached-answer language-
# mismatch guard doesn't reject it.

# The repair-path half of requirement 7 is proven by test_answer_release_
# sse_enforcement.py's test_visual_denial_repair_cannot_bypass_the_
# release_gate (+ this fix's new single-target sibling test): the repair
# branch structurally never runs for ANY restricted policy — the one
# centralized `if policy_has_release_restriction:` branch always wins
# before any repair/rewrite code is reached, regardless of which of the
# two release-decision functions it then dispatches to. Fresh-generation
# persistence (a NEWLY generated, released single-target hint actually
# reaching save_answer) is not separately exercised at the route level
# here: in this harness it depends on grounded_identity.source_confidence
# clearing _verification_is_cacheable's >= 0.72 threshold, which this
# test's synthetic one-line chunk mock does not reliably produce — the
# same kind of route-level reach gap test_answer_release_sse_enforcement.
# py's own Priority-4 comment already documents and declines to chase for
# an unrelated path. What IS guaranteed by direct code reading (app/
# routers/stream.py): full_text_buf is cleared and reset to release_
# decision.text BEFORE the final save_answer call joins it, for every
# branch under `if policy_has_release_restriction:` — so whatever gets
# persisted was always already gated, never the raw draft.
# ---------------------------------------------------------------------------

def test_single_target_cache_hit_replays_already_gated_hint(monkeypatch):
    draft_text = "irrelevant — this run must take the cache-hit path, not generate"
    conversation_id = "hint-suppression-cache-hit"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )

    cached_hint_text = "Think about Newton's second law before computing anything."
    monkeypatch.setattr(stream, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(
        stream, "lookup_answer",
        lambda **_: {
            "answer": cached_hint_text,
            "retrievalMode": "strong",
            "verification": {"status": "verified"},
        },
    )

    async def _run_no_open_context():
        payload = stream.AskStreamRequest(
            courseId="course-1",
            activeDocumentId=DOCUMENT_ID,
            # Deliberately QUESTION ("Solve Aufgabe 5b."), not a hint-
            # specific phrasing: this test is about the CACHE REPLAY
            # mechanism, not about which question wording compiles to
            # the restricted policy (that's hand-injected regardless of
            # literal question text via _setup's fake interpret_turn_
            # authoritatively) — and the route's unmocked, real dialogue/
            # identity resolution needs this exact phrasing to make
            # `cacheable` true in this harness (same chunk/retrieval
            # mocks as every other test in this file).
            question=QUESTION,
            visiblePage=1,
            sourceMode="course_files",
            conversationId=conversation_id,
            conversationGeneration=1,
            responseLanguage="en",
        )
        response = await stream.ask_stream_endpoint(payload, {"id": USER_ID})
        return b"".join([event async for event in response.body_iterator])

    try:
        body = asyncio.run(_run_no_open_context())
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    # cached_stream() replays the cached answer in 28-char chunks (see
    # stream.py's cached_stream()), so the full sentence never appears
    # as one contiguous substring in the raw SSE bytes — reconstruct it
    # from the "t" fragments instead of asserting a literal substring.
    import json as _json
    import re as _re
    streamed_text = "".join(
        _json.loads(f'"{escaped}"')
        for escaped in _re.findall(r'"t":\s*"((?:[^"\\]|\\.)*)"', body.decode(errors="replace"))
    )
    assert cached_hint_text in streamed_text, body
    assert b'"cacheHit": true' in body
    # A cache hit replays whatever was already persisted verbatim — it
    # does not (and structurally cannot, from stream.py's current
    # cached_stream() implementation) re-run the release gate. Safety
    # instead rests on save_answer's existing gate (not captured_meta.
    # get("recovery")) only ever persisting gate-approved text in the
    # first place — proven by every withheld-case test in this file and
    # in test_answer_release_sse_enforcement.py asserting `not save_calls`.
    del save_calls

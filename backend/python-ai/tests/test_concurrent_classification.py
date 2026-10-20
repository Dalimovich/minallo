"""Tests for ``app/services/concurrent_classification.py`` — the
asyncio.gather primitive for running call #1 (``resolve_dialogue_
semantically``) and call #2 (``interpret_student_intent``'s semantic
escalation) concurrently instead of today's two sequential
``run_in_threadpool`` awaits.

Nothing here is wired into ``app/routers/stream.py`` — these tests exercise
the new, additive helper directly. Every model-backed call is mocked via a
fake OpenAI client; zero real network/API calls are made.
"""

import json
import time

import pytest

from app import config as config_module
from app.services import openai_client
from app.services.concurrent_classification import gather_independent, resolve_dialogue_and_intent_concurrently
from app.services.dialogue_state import resolve_dialogue, resolve_dialogue_semantically
from app.services.grounding_contract import ResolvedDocumentAccess
from app.services.student_intent import interpret_student_intent


# ---------------------------------------------------------------------------
# gather_independent — generic failure isolation + genuine concurrency.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_one_call_failing_does_not_affect_the_others_result():
    def ok():
        return "fine"

    def boom():
        raise RuntimeError("defensive-only failure path")

    ok_result, boom_result = await gather_independent(ok, boom)
    assert ok_result.value == "fine"
    assert ok_result.error is None
    assert boom_result.value is None
    assert isinstance(boom_result.error, RuntimeError)


@pytest.mark.asyncio
async def test_calls_actually_run_concurrently_not_sequentially():
    def slow_a():
        time.sleep(0.2)
        return "a"

    def slow_b():
        time.sleep(0.2)
        return "b"

    started = time.perf_counter()
    results = await gather_independent(slow_a, slow_b)
    elapsed = time.perf_counter() - started
    assert [r.value for r in results] == ["a", "b"]
    # Sequential would take ~0.4s; concurrent should take ~0.2s. Generous
    # bound for CI jitter — this only needs to prove "not serialized".
    assert elapsed < 0.35


# ---------------------------------------------------------------------------
# resolve_dialogue_and_intent_concurrently — the two real call sites,
# gathered, both backed by a mocked OpenAI client.
# ---------------------------------------------------------------------------

class _FakeClient:
    """Same fake-SDK shape as test_student_intent.py / test_dialogue_state.py
    use for their own mocked model calls."""

    def __init__(self, content):
        self._content = content if isinstance(content, str) else json.dumps(content)
        self.call_count = 0

    def with_options(self, **_kwargs):
        return self

    @property
    def chat(self):
        outer = self

        class _Completions:
            @staticmethod
            def create(**_kwargs):
                outer.call_count += 1
                message = type("Msg", (), {"content": outer._content})()
                choice = type("Choice", (), {"message": message})()
                return type("Completion", (), {"choices": [choice], "usage": None})()

        return type("Chat", (), {"completions": _Completions()})()


@pytest.mark.asyncio
async def test_both_real_call_sites_gathered_with_mocked_clients_no_network(monkeypatch):
    dialogue_client = _FakeClient({
        "relation": "correct_assistant", "speechAct": "statement", "taskFamily": "explain",
        "continuesPreviousGoal": True, "resolvedRequest": "No, that's wrong.", "confidence": 0.9,
    })
    intent_client = _FakeClient({
        "primaryTask": "general_course_qa", "prohibitedTasks": [], "depth": "detailed",
        "teachingStyle": "default", "visualRequirement": False, "confidence": 0.9,
    })

    # Both call sites share the same client-lookup helper in production
    # (see student_intent.py's module docstring: "mirrors resolve_dialogue_
    # semantically's call shape exactly, same client helper"), so one
    # monkeypatch covers both — proving neither makes a real network call.
    calls = {"n": 0}

    def fake_get_client():
        calls["n"] += 1
        return dialogue_client if calls["n"] == 1 else intent_client

    monkeypatch.setattr(openai_client, "get_openai_client", fake_get_client)
    monkeypatch.setattr(
        config_module, "get_settings",
        lambda: type("S", (), {"openai_generate_model": "gpt-4o-mini", "openai_reasoning_effort": "high"})(),
    )

    previous_turns = [{"role": "assistant", "text": "The answer is 42 N."}]
    base_dialogue = resolve_dialogue("No, that's wrong.", previous_turns=previous_turns)

    dialogue_result, intent_result = await resolve_dialogue_and_intent_concurrently(
        dialogue_call=lambda: resolve_dialogue_semantically(
            "No, that's wrong.", previous_turns=previous_turns, base=base_dialogue,
        ),
        intent_call=lambda: interpret_student_intent(
            "No, that's wrong.", dialogue=base_dialogue,
            resolved_access=ResolvedDocumentAccess.RELEVANCE,
            mode="enabled", previous_turns=previous_turns,
        ),
    )

    assert dialogue_result.error is None
    assert intent_result.error is None
    assert dialogue_result.value is not None
    assert intent_result.value is not None
    # Both fakes were actually invoked (not skipped) and nothing hit the network.
    assert dialogue_client.call_count == 1
    assert intent_client.call_count == 1


# ---------------------------------------------------------------------------
# Hardening pass (code review): "a passing asyncio.gather test is not
# sufficient evidence of semantic equivalence." This reproduces a concrete
# case where the concurrent design's documented accuracy trade-off (call #2
# sees the deterministic `base` dialogue, not call #1's resolved output)
# actually changes the result — not just a theoretical risk.
# ---------------------------------------------------------------------------

def test_concurrent_path_produces_a_measurably_less_resolved_student_goal(monkeypatch):
    """"go ahead", replying to an assistant offer to extend a flashcard set
    to screws. TODAY's sequential behavior (call #1 fully resolves first,
    THEN call #2 runs against that) classifies this correctly as
    FLASHCARD_GENERATION with a goal that names "screws". The concurrent
    helper's documented design runs call #2 against the deterministic
    `base` instead — which never heard the semantic resolution at all — and
    gets the generic, unresolved GENERAL_COURSE_QA. This is the real cost
    side of the trade-off the module docstring now documents; it is NOT
    evidence the trade-off is acceptable, only that it is real."""
    from app.services.answer_intent import AcademicIntent

    previous_turns = [
        {"role": "user", "text": "Create flashcards about bearings."},
        {"role": "assistant", "text": "Should I make the same set for screws?"},
    ]
    base_dialogue = resolve_dialogue("go ahead", previous_turns=previous_turns)
    assert base_dialogue.resolved_request == "go ahead"  # deterministic layer doesn't know what "go ahead" means yet

    client = _FakeClient({
        "relation": "answer_to_assistant", "speechAct": "confirmation", "taskFamily": "flashcards",
        "continuesPreviousGoal": True, "resolvedRequest": "Create flashcards about screws too.",
        "confidence": 0.92,
    })
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: client)
    monkeypatch.setattr(
        config_module, "get_settings",
        lambda: type("S", (), {"openai_generate_model": "gpt-4o-mini", "openai_reasoning_effort": "high"})(),
    )

    # Sequential (today's real behavior): call #2 sees call #1's resolution.
    resolved_dialogue = resolve_dialogue_semantically(
        "go ahead", previous_turns=previous_turns, base=base_dialogue,
    )
    sequential_intent = interpret_student_intent(
        "go ahead", dialogue=resolved_dialogue,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, mode="off",
    )

    # Concurrent helper's documented design: call #2 sees only `base`.
    concurrent_intent = interpret_student_intent(
        "go ahead", dialogue=base_dialogue,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, mode="off",
    )

    assert sequential_intent.student_goal != concurrent_intent.student_goal
    assert "screw" in sequential_intent.student_goal.lower()
    assert concurrent_intent.student_goal == "go ahead"
    assert sequential_intent.primary_task is AcademicIntent.FLASHCARD_GENERATION
    assert concurrent_intent.primary_task is AcademicIntent.GENERAL_COURSE_QA
    assert sequential_intent.primary_task != concurrent_intent.primary_task

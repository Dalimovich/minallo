"""Tests for ``app/services/unified_semantic_call.py`` (Decision 1): the
one-call adapter proposal, its validators/fallback, and a comparison
harness against the EXISTING sequential two-call design (both mocked —
zero real network/API calls anywhere in this file).

Not wired into any router. ``compile_policy`` is the real, already-tested
downstream consumer used here to prove invariant (c) from the module
docstring (independent authorization is unaffected by which call shape
produced the candidate).
"""

import json

import pytest

from app import config as config_module
from app.services import openai_client
from app.services.dialogue_state import resolve_dialogue, resolve_dialogue_semantically
from app.services.grounding_contract import ResolvedDocumentAccess
from app.services.policy_compiler import compile_policy
from app.services.resolved_student_intent import Action, ReleaseConstraints
from app.services.student_intent import interpret_student_intent
from app.services.unified_semantic_call import build_unified_call_frame, safe_fallback, validate_unified_call_output


# ---------------------------------------------------------------------------
# build_unified_call_frame — the one prompt's input (deterministic context
# only, invariant (a)).
# ---------------------------------------------------------------------------

def test_frame_carries_message_and_bounded_recent_turns():
    turns = [{"role": "user", "text": f"turn {i}"} for i in range(20)]
    frame = build_unified_call_frame(message="hello", previous_turns=turns, active_task_hint="flashcards")
    assert frame["currentMessage"] == "hello"
    assert len(frame["recentTurns"]) == 10  # bounded, same window as today's two calls
    assert frame["activeTaskHint"] == "flashcards"


def test_frame_never_accepts_document_text():
    import inspect
    params = set(inspect.signature(build_unified_call_frame).parameters)
    forbidden = {"chunks", "document_text", "context", "retrieved_text", "course_text"}
    assert not (params & forbidden)


# ---------------------------------------------------------------------------
# validate_unified_call_output — schema + consistency, reusing
# semantic_call_support.validate_semantic_action per action.
# ---------------------------------------------------------------------------

def _valid_raw(**overrides):
    payload = {
        "conversation": "new", "studentGoal": "Explain torsion.", "responseLanguage": "en",
        "confidence": 0.9,
        "actions": [{"objective": "explain", "target": "task", "confidence": 0.9, "release": {}}],
    }
    payload.update(overrides)
    return payload


def test_valid_unified_payload_accepted():
    intent = validate_unified_call_output(_valid_raw(), original_message="x", student_goal_fallback="x")
    assert intent is not None
    assert intent.conversation == "new"
    assert intent.student_goal == "Explain torsion."
    assert len(intent.actions) == 1


def test_unknown_conversation_value_rejected():
    assert validate_unified_call_output(
        _valid_raw(conversation="not_a_real_relation"), original_message="x", student_goal_fallback="x",
    ) is None


def test_below_confidence_floor_rejected():
    assert validate_unified_call_output(
        _valid_raw(confidence=0.4), original_message="x", student_goal_fallback="x",
    ) is None


def test_empty_actions_list_rejected():
    assert validate_unified_call_output(
        _valid_raw(actions=[]), original_message="x", student_goal_fallback="x",
    ) is None


def test_too_many_actions_rejected():
    many = [{"objective": "explain", "target": f"t{i}", "confidence": 0.9, "release": {}} for i in range(20)]
    assert validate_unified_call_output(
        _valid_raw(actions=many), original_message="x", student_goal_fallback="x",
    ) is None


def test_one_malformed_action_fails_the_whole_call_no_partial_trust():
    actions = [
        {"objective": "explain", "target": "5", "confidence": 0.9, "release": {}},
        {"objective": "not_a_real_objective", "target": "6", "confidence": 0.9, "release": {}},
    ]
    assert validate_unified_call_output(
        _valid_raw(actions=actions), original_message="x", student_goal_fallback="x",
    ) is None


def test_consistency_check_reused_per_action_against_base():
    base = Action(objective="solve", target="5", release=ReleaseConstraints(final_answer="prohibited"))
    actions = [{"objective": "solve", "target": "5", "confidence": 0.9, "release": {"final_answer": "permitted"}}]
    result = validate_unified_call_output(
        _valid_raw(actions=actions), original_message="x", student_goal_fallback="x",
        base_actions={"5": base},
    )
    assert result is None  # the model may not loosen a trusted prohibition, same rule as the two-call design


def test_platform_forbidden_reused_in_unified_validation():
    actions = [{"objective": "official_solution", "target": "5", "confidence": 0.9, "release": {"official_solution": "permitted"}}]
    result = validate_unified_call_output(
        _valid_raw(actions=actions), original_message="x", student_goal_fallback="x",
        platform_forbidden={"official_solution": "prohibited"},
    )
    assert result is None


def test_multi_action_output_case_c_shaped():
    """The one-call design's whole point: produce what today's two-call
    design (one global primaryTask) structurally cannot — two actions,
    opposite constraints, in ONE response."""
    actions = [
        {"objective": "official_solution", "target": "5", "state": "prohibited", "confidence": 0.9,
         "release": {"final_answer": "prohibited"}},
        {"objective": "official_solution", "target": "6", "state": "requested", "confidence": 0.9,
         "release": {"official_solution": "permitted"}},
    ]
    intent = validate_unified_call_output(
        _valid_raw(actions=actions, studentGoal="Keine Lösung für 5, volle Lösung für 6."),
        original_message="x", student_goal_fallback="x",
    )
    assert intent is not None
    policy = compile_policy(intent)
    by_target = {a.target: a.release for a in policy.actions}
    assert by_target["5"].final_answer == "prohibited"
    assert by_target["6"].official_solution == "permitted"


# ---------------------------------------------------------------------------
# safe_fallback — reuses policy_compiler's existing restrictive machinery,
# invariant (e). Also demonstrates invariant (d)'s real cost: everything
# degrades together, not independently.
# ---------------------------------------------------------------------------

def test_safe_fallback_forces_every_action_unresolved_and_compiles_restrictively():
    actions = (
        Action(objective="explain", target="5", state="requested"),
        Action(objective="solve", target="6", state="requested"),
    )
    fallback_intent = safe_fallback(original_message="x", student_goal="x", actions=actions)
    assert all(a.state == "unresolved" for a in fallback_intent.actions)
    policy = compile_policy(fallback_intent)
    assert policy.needs_clarification is True
    for action in policy.actions:
        assert action.release.final_answer == "prohibited"
        assert action.release.official_solution == "prohibited"


def test_safe_fallback_with_no_prior_actions_still_produces_a_valid_intent():
    fallback_intent = safe_fallback(original_message="x", student_goal="x", actions=())
    policy = compile_policy(fallback_intent)
    assert policy.needs_clarification is True


# ---------------------------------------------------------------------------
# Comparison harness: one-call design vs. today's sequential two-call
# design, both mocked. Reuses the real functions for the two-call side
# (resolve_dialogue_semantically + interpret_student_intent) so the
# baseline is the ACTUAL deployed behavior, not a re-description of it.
# ---------------------------------------------------------------------------

class _FakeClient:
    def __init__(self, content):
        self._content = content if isinstance(content, str) else json.dumps(content)

    def with_options(self, **_kwargs):
        return self

    @property
    def chat(self):
        outer = self

        class _Completions:
            @staticmethod
            def create(**_kwargs):
                message = type("Msg", (), {"content": outer._content})()
                choice = type("Choice", (), {"message": message})()
                return type("Completion", (), {"choices": [choice], "usage": None})()

        return type("Chat", (), {"completions": _Completions()})()


def _patch_model(monkeypatch, client):
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: client)
    monkeypatch.setattr(
        config_module, "get_settings",
        lambda: type("S", (), {"openai_generate_model": "gpt-4o-mini", "openai_reasoning_effort": "high"})(),
    )


def _sequential_two_call_student_goal(message, previous_turns, dialogue_payload, intent_payload, monkeypatch):
    """Today's REAL, deployed sequential behavior: call #1 fully resolves,
    then call #2 runs against that resolved dialogue."""
    base_dialogue = resolve_dialogue(message, previous_turns=previous_turns)
    _patch_model(monkeypatch, _FakeClient(dialogue_payload))
    resolved_dialogue = resolve_dialogue_semantically(message, previous_turns=previous_turns, base=base_dialogue)
    _patch_model(monkeypatch, _FakeClient(intent_payload))
    intent = interpret_student_intent(
        message, dialogue=resolved_dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE, mode="off",
    )
    return intent.student_goal, resolved_dialogue.relation.value


@pytest.mark.parametrize(("message", "previous_turns", "dialogue_payload", "intent_payload", "unified_payload"), [
    (
        "go ahead",
        [
            {"role": "user", "text": "Create flashcards about bearings."},
            {"role": "assistant", "text": "Should I make the same set for screws?"},
        ],
        {"relation": "answer_to_assistant", "speechAct": "confirmation", "taskFamily": "flashcards",
         "continuesPreviousGoal": True, "resolvedRequest": "Create flashcards about screws too.", "confidence": 0.92},
        {"primaryTask": "flashcard_generation", "prohibitedTasks": [], "depth": "normal",
         "teachingStyle": "default", "visualRequirement": False, "confidence": 0.9},
        {"conversation": "follow_up", "studentGoal": "Create flashcards about screws too.",
         "responseLanguage": "en", "confidence": 0.9,
         "actions": [{"objective": "other", "target": "flashcards_screws", "confidence": 0.9, "release": {}}]},
    ),
    (
        "No, that's wrong.",
        [{"role": "assistant", "text": "The answer is 42 N."}],
        {"relation": "correction", "speechAct": "answer", "taskFamily": "explain",
         "continuesPreviousGoal": True, "resolvedRequest": "No, that's wrong.", "confidence": 0.9},
        {"primaryTask": "general_course_qa", "prohibitedTasks": [],
         "depth": "normal", "teachingStyle": "default", "visualRequirement": False, "confidence": 0.9},
        {"conversation": "correction", "studentGoal": "No, that's wrong.", "responseLanguage": "en",
         "confidence": 0.9,
         "actions": [{"objective": "review_student_solution", "target": "previous_answer", "confidence": 0.9, "release": {}}]},
    ),
])
def test_unified_call_matches_sequential_two_call_on_goal_resolution(
    monkeypatch, message, previous_turns, dialogue_payload, intent_payload, unified_payload,
):
    """Both designs must agree on WHAT the student is actually asking
    for, resolved against the same conversation. The one-call design
    does not lose accuracy relative to today's sequential (not
    asyncio.gather) baseline on these two dialogue-relation-dependent
    fixtures."""
    sequential_goal, dialogue_relation = _sequential_two_call_student_goal(
        message, previous_turns, dialogue_payload, intent_payload, monkeypatch,
    )

    unified_intent = validate_unified_call_output(
        unified_payload, original_message=message, student_goal_fallback=message,
    )
    assert unified_intent is not None
    assert unified_intent.student_goal == sequential_goal
    # Both recognize the same conversational shape (confirmation/follow-up
    # vs. a correction) even though the vocabularies differ
    # (TurnRelation vs. ConversationShape) — spot-checked per fixture.
    if dialogue_relation == "correction":
        assert unified_intent.conversation == "correction"
    else:
        assert unified_intent.conversation == "follow_up"


def test_unified_call_language_persistence_case_i_shaped(monkeypatch):
    """"und Aufgabe 2?" after an earlier "explain it in English" turn —
    the one-call design must still be able to carry the persisted
    language instruction via conversation_turn provenance, same as a
    two-call design relying on dialogue_state's resolution would."""
    from app.services.resolved_student_intent import Origin, TurnLedger

    unified_payload = {
        "conversation": "follow_up", "studentGoal": "und Aufgabe 2?", "responseLanguage": "en",
        "confidence": 0.9,
        "actions": [{
            "objective": "answer_subquestion", "target": "2", "confidence": 0.9, "release": {},
        }],
    }
    intent = validate_unified_call_output(unified_payload, original_message="und Aufgabe 2?", student_goal_fallback="x")
    assert intent is not None
    # The validator can't attach provenance itself (it only sees the raw
    # action payload) — a real M3 caller would attach it from the
    # trusted turn context the same way the existing interpreter does.
    from dataclasses import replace
    intent = replace(intent, actions=tuple(
        replace(a, provenance=(Origin(kind="conversation_turn", turn_id="turn-1"),)) for a in intent.actions
    ))
    ledger = TurnLedger.build(conversation_id="conv-1", turns={"turn-1": {"response_language": "en"}})
    policy = compile_policy(intent, turn_ledger=ledger)
    assert policy.response_language == "en"
    assert policy.response_language_reason == "persisted_explicit_instruction:turn=turn-1"

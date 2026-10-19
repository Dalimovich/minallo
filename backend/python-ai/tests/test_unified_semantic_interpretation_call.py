"""Tests for the REAL unified semantic call (Milestone 3 Phase A) —
``unified_semantic_call.perform_unified_semantic_interpretation``.

Mocks the OpenAI client exactly like test_student_intent.py / test_
dialogue_state.py already do for the two calls this one is designed to
replace in ENABLED mode — never a real network call."""

import json

import pytest

from app import config as config_module
from app.services import openai_client
from app.services.dialogue_state import (
    DialogueAct, SpeechAct, TaskFamily, TurnRelation, resolve_dialogue,
)
from app.services.resolved_student_intent import Action, ReleaseConstraints
from app.services.unified_semantic_call import (
    UnifiedInterpretation, perform_unified_semantic_interpretation,
)


class _FakeClient:
    """Same fake shape as test_student_intent.py's _FakeClient — one
    chat.completions.create call, captures its kwargs so the one-call
    budget and the request shape can both be asserted."""

    def __init__(self, content):
        self._content = content if isinstance(content, str) else json.dumps(content)
        self.captured_kwargs: dict = {}
        self.call_count = 0

    def with_options(self, **_kwargs):
        return self

    @property
    def chat(self):
        outer = self

        class _Completions:
            @staticmethod
            def create(**kwargs):
                outer.call_count += 1
                outer.captured_kwargs.update(kwargs)
                message = type("Msg", (), {"content": outer._content})()
                choice = type("Choice", (), {"message": message})()
                return type("Completion", (), {"choices": [choice], "usage": None})()

        return type("Chat", (), {"completions": _Completions()})()


def _patch_model(monkeypatch, client, model: str = "gpt-4o-mini"):
    monkeypatch.setattr(openai_client, "get_openai_client", lambda: client)
    monkeypatch.setattr(
        config_module, "get_settings",
        lambda: type("S", (), {
            "openai_generate_model": model, "openai_reasoning_effort": "high",
        })(),
    )


_VALID_DIALOGUE_FIELDS = {
    "relation": "new_topic", "speechAct": "question", "taskFamily": "solve",
    "continuesPreviousGoal": False, "resolvedRequest": "Solve exercise 5a",
    "confidence": 0.9,
}
_VALID_SINGLE_ACTION = {
    "conversation": "new", "studentGoal": "Solve 5a", "responseLanguage": "en",
    "actions": [{
        "objective": "solve", "target": "5a", "confidence": 0.9, "state": "requested",
        "release": {"final_answer": "permitted"},
    }],
}


def test_one_call_budget(monkeypatch):
    client = _FakeClient({**_VALID_DIALOGUE_FIELDS, **_VALID_SINGLE_ACTION})
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Solve exercise 5a", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Solve exercise 5a", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5a",
    )

    assert result is not None
    assert client.call_count == 1


def test_full_dialogue_projection_overrides_addressed_fields_inherits_rest(monkeypatch):
    """Fields the model's JSON explicitly addresses get overridden; fields
    it doesn't (requested_depth, explanation_attempt, referent_type,
    referent_text, response_language, dialogue_act, active_question,
    previous_question, invalidate_previous_answer) are inherited VERBATIM
    from the deterministic base -- the override-merge pattern, not a
    hand-written field-by-field copy."""
    client = _FakeClient({
        "relation": "correction", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": True, "resolvedRequest": "Actually solve 5b, not 5a",
        "confidence": 0.95,
        "conversation": "exercise_switch", "studentGoal": "Solve 5b instead",
        "responseLanguage": "en",
        "actions": [{
            "objective": "solve", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {"final_answer": "permitted"},
        }],
    })
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("I meant 5b, not 5a.", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="I meant 5b, not 5a.", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5b instead",
    )

    assert result is not None
    dialogue = result.dialogue
    # Addressed by the model -> overridden.
    assert dialogue.relation is TurnRelation.CORRECTION
    assert dialogue.speech_act is SpeechAct.TASK_REQUEST
    assert dialogue.task_family is TaskFamily.SOLVE
    assert dialogue.continues_previous_goal is True
    assert dialogue.resolved_request == "Actually solve 5b, not 5a"
    assert dialogue.confidence == pytest.approx(0.95)
    # NOT addressed by the model -> inherited verbatim from the
    # deterministic base, never invented.
    assert dialogue.requested_depth == base.requested_depth
    assert dialogue.explanation_attempt == base.explanation_attempt
    assert dialogue.referent_type == base.referent_type
    assert dialogue.referent_text == base.referent_text
    assert dialogue.response_language == base.response_language
    assert dialogue.dialogue_act == base.dialogue_act
    assert dialogue.active_question == base.active_question
    assert dialogue.previous_question == base.previous_question
    assert dialogue.invalidate_previous_answer == base.invalidate_previous_answer
    # prompt_overlay()/to_api() need no new code -- both are derived from
    # the dataclass fields this function assembled.
    overlay = dialogue.prompt_overlay()
    assert "Actually solve 5b, not 5a" in overlay
    api = dialogue.to_api()
    assert api["relation"] == "correction"


def test_multi_target_opposite_permissions_extracted_as_two_actions(monkeypatch):
    """The core Milestone 2/3 case: two exercises, opposite release
    constraints, in one message -- must come through as two distinct
    Actions, never collapsed into one."""
    client = _FakeClient({
        **_VALID_DIALOGUE_FIELDS,
        "conversation": "new", "studentGoal": "5a full answer, 5b hint only",
        "responseLanguage": "en",
        "actions": [
            {"objective": "solve", "target": "5a", "confidence": 0.9, "state": "requested",
             "release": {"final_answer": "permitted"}},
            {"objective": "hint", "target": "5b", "confidence": 0.9, "state": "requested",
             "release": {"final_answer": "prohibited", "form": "hint"}},
        ],
    })
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Show the answer for 5a, but only a hint for 5b.", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Show the answer for 5a, but only a hint for 5b.", dialogue_base=base,
        previous_turns=[], student_goal_fallback="5a full answer, 5b hint only",
    )

    assert result is not None
    actions = {a.target: a for a in result.intent.actions}
    assert actions["5a"].release.final_answer == "permitted"
    assert actions["5b"].release.final_answer == "prohibited"
    assert actions["5b"].release.form == "hint"


def test_transport_failure_returns_none(monkeypatch):
    class _BoomClient:
        def with_options(self, **_kwargs):
            return self

        @property
        def chat(self):
            class _Completions:
                @staticmethod
                def create(**_kwargs):
                    raise TimeoutError("simulated provider timeout")
            return type("Chat", (), {"completions": _Completions()})()

    _patch_model(monkeypatch, _BoomClient())
    base = resolve_dialogue("Solve exercise 5a", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Solve exercise 5a", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5a",
    )
    assert result is None


def test_malformed_dialogue_half_fails_the_whole_call(monkeypatch):
    """Invariant (d): one half failing fails BOTH -- no partial trust."""
    client = _FakeClient({
        "relation": "not_a_real_relation",  # malformed
        "speechAct": "question", "taskFamily": "solve",
        "continuesPreviousGoal": False, "resolvedRequest": "Solve 5a", "confidence": 0.9,
        **_VALID_SINGLE_ACTION,
    })
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Solve exercise 5a", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Solve exercise 5a", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5a",
    )
    assert result is None


def test_malformed_intent_half_fails_the_whole_call(monkeypatch):
    client = _FakeClient({
        **_VALID_DIALOGUE_FIELDS,
        "conversation": "not_a_real_conversation_shape",  # malformed
        "studentGoal": "Solve 5a", "responseLanguage": "en",
        "actions": [{"objective": "solve", "target": "5a", "confidence": 0.9, "release": {}}],
    })
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Solve exercise 5a", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Solve exercise 5a", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5a",
    )
    assert result is None


def test_low_confidence_dialogue_half_fails_the_whole_call(monkeypatch):
    client = _FakeClient({
        **_VALID_DIALOGUE_FIELDS, "confidence": 0.1,  # below the 0.65 floor
        **_VALID_SINGLE_ACTION,
    })
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Solve exercise 5a", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Solve exercise 5a", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5a",
    )
    assert result is None


def test_never_loosens_a_trusted_base_action(monkeypatch):
    """The model may add a restriction but never remove one already
    trusted -- same invariant semantic_call_support.validate_semantic_
    action already enforces, exercised here through the real call path."""
    client = _FakeClient({
        **_VALID_DIALOGUE_FIELDS,
        "conversation": "new", "studentGoal": "Solve 5a", "responseLanguage": "en",
        "actions": [{
            "objective": "solve", "target": "5a", "confidence": 0.9, "state": "requested",
            "release": {"final_answer": "permitted"},  # tries to loosen a trusted prohibition
        }],
    })
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Solve exercise 5a", previous_turns=[])
    trusted_base_action = Action(
        objective="solve", target="5a",
        release=ReleaseConstraints(final_answer="prohibited"),
    )

    result = perform_unified_semantic_interpretation(
        message="Solve exercise 5a", dialogue_base=base, previous_turns=[],
        student_goal_fallback="Solve 5a", base_actions={"5a": trusted_base_action},
    )
    assert result is None

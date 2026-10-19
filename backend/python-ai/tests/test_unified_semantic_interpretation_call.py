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
    UnifiedInterpretation, perform_unified_semantic_interpretation, validate_unified_call_output,
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


# ---------------------------------------------------------------------------
# Live-eval regression (2026-10-20 independent evaluation, reports/
# semantic-intent-phase-d-eval-2026-10-20.json, case "hint-direct-en"):
# the real gpt-4o-mini model, given the OLD _UNIFIED_SYSTEM_PROMPT_
# TEMPLATE, returned its answer nested under literal top-level keys
# "Dialogue fields" / "Intent fields" (reading those labels in the old
# prompt text as JSON wrapper keys, not section headings) instead of the
# flat top-level keys _validate_dialogue_half/validate_unified_call_
# output actually read. Both validators therefore read `raw.get(...)`
# against the wrong level, found nothing, and the WHOLE call failed
# closed (returned None) -- even though the model's actual extracted
# values (target "exercise 7", release.final_answer "prohibited",
# release.form "hint") were exactly correct. 20/20 live-model cases
# across that eval's corpus failed the same way. The caller then fell
# back to a much lower-fidelity deterministic path, which is why the
# eval's reported layer1_actions for this case show target "7" (regex-
# extracted from the message text) and release all "unspecified" --
# neither of those came from the model's real response at all.
#
# Fixed by rewriting the prompt (unified_semantic_call.py's
# _UNIFIED_SYSTEM_PROMPT_TEMPLATE) to say explicitly that "Dialogue
# fields"/"Intent fields" are section labels for the reader only, never
# JSON keys, and to show one concrete flat-shape example. This is a
# prompt-only change -- the validators' flat-key contract was already
# correct and is deliberately left untouched (weakening it to also
# accept a nested shape would hide a real prompt regression behind a
# silently-more-permissive parser instead of surfacing it).
#
# These two tests prove both halves of that contract with the REAL
# recorded shapes: the exact malformed nested payload the live model
# produced under the OLD prompt must still fail closed (proving this
# fix did not weaken the parser to paper over bad model output), and
# the same semantic content, flattened the way the NEW prompt asks for,
# must be accepted with exactly the values the student actually
# requested.
# ---------------------------------------------------------------------------

_LIVE_EVAL_HINT_DIRECT_EN_NESTED_RESPONSE = {
    "Dialogue fields": {
        "relation": "new_topic", "speechAct": "task_request", "taskFamily": "unknown",
        "continuesPreviousGoal": False, "resolvedRequest": False, "confidence": 0.9,
    },
    "Intent fields": {
        "conversation": "new", "studentGoal": "request_a_hint", "responseLanguage": "unspecified",
        "actions": [{
            "objective": "hint", "target": "exercise 7", "confidence": 0.9, "state": "requested",
            "prohibited": [],
            "release": {
                "final_answer": "prohibited", "official_solution": "prohibited",
                "explanation_depth": "unspecified", "form": "hint",
                "max_steps": None, "max_items": None, "wait_for_student": None,
            },
        }],
    },
}


def test_real_eval_recorded_nested_response_still_fails_closed(monkeypatch):
    """The exact raw ``choices[0].message.content`` the live model
    returned for eval case "hint-direct-en" under the OLD prompt (see
    reports/semantic-intent-phase-d-eval-2026-10-20.json in the eval
    worktree) -- both validators look for flat top-level keys, find
    none (everything is nested one level down), and the whole call
    fails closed. Confirms the fix is a prompt change, not a parser
    change: this malformed shape is NOT silently accepted."""
    client = _FakeClient(_LIVE_EVAL_HINT_DIRECT_EN_NESTED_RESPONSE)
    _patch_model(monkeypatch, client)
    base = resolve_dialogue("Can you give me a hint for exercise 7, not the full answer?", previous_turns=[])

    result = perform_unified_semantic_interpretation(
        message="Can you give me a hint for exercise 7, not the full answer?",
        dialogue_base=base, previous_turns=[], student_goal_fallback="request_a_hint",
    )
    assert result is None


def test_same_content_flattened_as_the_fixed_prompt_requires_is_accepted_correctly():
    """Same case, same real values, flattened the way the rewritten
    prompt now explicitly asks for (no "Dialogue fields"/"Intent
    fields" wrapper) -- this is what the fix aims to make the live
    model actually produce. Proves the flat contract itself correctly
    carries the student's real request (hint-only, final answer and
    official solution both withheld) through to a compiled policy,
    once the model emits it in the shape the validators read."""
    flat_response = {
        **_LIVE_EVAL_HINT_DIRECT_EN_NESTED_RESPONSE["Dialogue fields"],
        **_LIVE_EVAL_HINT_DIRECT_EN_NESTED_RESPONSE["Intent fields"],
    }
    base = resolve_dialogue("Can you give me a hint for exercise 7, not the full answer?", previous_turns=[])

    intent = validate_unified_call_output(
        flat_response, original_message="Can you give me a hint for exercise 7, not the full answer?",
        student_goal_fallback="request_a_hint",
    )
    assert intent is not None
    assert len(intent.actions) == 1
    action = intent.actions[0]
    assert action.objective == "hint"
    assert action.release.final_answer == "prohibited"
    assert action.release.official_solution == "prohibited"
    assert action.release.form == "hint"

    from app.services.policy_compiler import compile_policy  # noqa: WPS433
    policy = compile_policy(intent)
    compiled = next(a for a in policy.actions if a.target == action.target)
    # The correctness this whole eval/fix is about: a genuine hint-only
    # request must compile to final_answer=prohibited, never silently
    # open to "permitted" because extraction missed the field (the
    # exact failure mode the live eval exposed for 20/20 cases).
    assert compiled.release.final_answer == "prohibited"
    assert compiled.release.form == "hint"

"""Tests for the authoritative Semantic Student Intent Layer orchestrator
(Milestone 4 Phases A/B) — app/services/semantic_intent_orchestrator.py.

Mocks the OpenAI client (same pattern as test_unified_semantic_
interpretation_call.py) and the conversation_store boundary (same pattern
as test_diagnostic_policy.py) — never a real network/database call."""

import json

import pytest

from app import config as config_module
from app.services import openai_client
from app.services.dialogue_state import resolve_dialogue
from app.services.diagnostic_policy import adapt_deterministic_intent
from app.services.grounding_contract import (
    AccessResolutionReason, ResolvedDocumentAccess, resolve_document_access,
)
from app.services.student_intent import interpret_student_intent
from app.services.semantic_intent_orchestrator import (
    build_authoritative_turn_ledger, correct_full_document_scope_false_positive,
    interpret_turn_authoritatively,
)


class _FakeClient:
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
            def create(**kwargs):
                outer.call_count += 1
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


_MULTI_TARGET_RESPONSE = {
    "relation": "new_topic", "speechAct": "task_request", "taskFamily": "solve",
    "continuesPreviousGoal": False, "resolvedRequest": "Show 5a, hint for 5b",
    "confidence": 0.9,
    "conversation": "new", "studentGoal": "Show 5a, hint for 5b", "responseLanguage": "en",
    "actions": [
        {"objective": "solve", "target": "5a", "confidence": 0.9, "state": "requested",
         "release": {"final_answer": "permitted"}},
        {"objective": "hint", "target": "5b", "confidence": 0.9, "state": "requested",
         "release": {"final_answer": "prohibited", "form": "hint"}},
    ],
}


def test_escalation_triggers_exactly_one_model_call(monkeypatch):
    client = _FakeClient(_MULTI_TARGET_RESPONSE)
    _patch_model(monkeypatch, client)
    message = 'Show the answer for 5a, but "only a hint" for 5b.'
    dialogue = resolve_dialogue(message, previous_turns=[])

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id=None,
        validate_ownership=lambda **_: False, get_messages=lambda **_: [],
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )

    assert client.call_count == 1
    assert result.used_unified_call is True
    assert result.unified_call_succeeded is True
    targets = {a.target: a for a in result.execution_policy.actions}
    assert targets["5a"].release.final_answer == "permitted"
    assert targets["5b"].release.final_answer == "prohibited"
    assert targets["5b"].release.form == "hint"


def test_no_escalation_needed_makes_zero_model_calls(monkeypatch):
    client = _FakeClient(_MULTI_TARGET_RESPONSE)
    _patch_model(monkeypatch, client)
    message = "What is torsion?"
    dialogue = resolve_dialogue(message, previous_turns=[])

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id=None,
        validate_ownership=lambda **_: False, get_messages=lambda **_: [],
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )

    assert client.call_count == 0
    assert result.used_unified_call is False
    assert len(result.execution_policy.actions) == 1


def test_unified_call_failure_falls_back_deterministic_no_extra_call(monkeypatch):
    client = _FakeClient("not valid json {{{")
    _patch_model(monkeypatch, client)
    message = 'Show 5a, but "no solution" for 5b.'
    dialogue = resolve_dialogue(message, previous_turns=[])

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id=None,
        validate_ownership=lambda **_: False, get_messages=lambda **_: [],
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )

    assert client.call_count == 1  # the one attempted call, which failed
    assert result.used_unified_call is True
    assert result.unified_call_succeeded is False
    # Degraded to the deterministic adapter -- still produces a valid policy.
    assert len(result.execution_policy.actions) >= 1


def test_authoritative_ledger_never_built_from_unowned_conversation():
    ledger = build_authoritative_turn_ledger(
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: False,  # not owned
        get_messages=lambda **_: [{"client_message_id": "m1", "role": "user", "content": "leak"}],
    )
    assert ledger is None


def test_authoritative_ledger_built_from_full_messages_function(monkeypatch):
    """Uses whatever get_messages the caller injects -- the production
    call site (stream.py) must inject the FULL get_durable_conversation_
    messages, never the diagnostics-only bounded variant, since this
    ledger drives real permission decisions."""
    calls = []

    def fake_get_messages(*, user_id, conversation_id):
        calls.append((user_id, conversation_id))
        return [{"client_message_id": "m1", "role": "user", "content": "..."}]

    ledger = build_authoritative_turn_ledger(
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=fake_get_messages,
    )
    assert ledger is not None
    assert calls == [("user-1", "conv-1")]
    assert ledger.conversation_id == "conv-1"


def test_authoritative_ledger_is_none_without_conversation_id():
    ledger = build_authoritative_turn_ledger(
        user_id="user-1", conversation_id=None,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    assert ledger is None


# ---------------------------------------------------------------------------
# Phase B required deliverable: the document-scope bug. Both sentences
# below are the ORIGINAL reported bug's exact examples; confirmed to
# trigger grounding_contract._FULL_DOCUMENT_RE as false positives before
# this fix (reproduced directly: "the whole Aufgabe" and "gesamten PDFs"
# both match the raw lexical regex despite meaning the opposite).
# ---------------------------------------------------------------------------

def _resolve(message: str):
    dialogue = resolve_dialogue(message, previous_turns=[])
    student_intent = interpret_student_intent(
        message, dialogue=dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE, mode="off",
    )
    resolved_intent = adapt_deterministic_intent(message=message, dialogue=dialogue, student_intent=student_intent)
    access, reason = resolve_document_access(question=message, requested=None, viewer_context=None)
    return dialogue, resolved_intent, access, reason


def test_incomplete_answer_complaint_is_not_routed_to_full_document():
    message = "You didn't answer the whole Aufgabe. Parts a and c are missing."
    dialogue, resolved_intent, access, reason = _resolve(message)
    assert reason is AccessResolutionReason.NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT  # confirms the bug would fire

    corrected_access, corrected_reason = correct_full_document_scope_false_positive(
        resolved_access=access, resolution_reason=reason,
        resolved_intent=resolved_intent, dialogue=dialogue,
    )
    assert corrected_access is ResolvedDocumentAccess.RELEVANCE
    assert corrected_reason is AccessResolutionReason.POLICY_OVERRIDE


def test_explicit_rejection_of_full_document_summary_is_not_routed_to_full_document():
    message = "Ich möchte keine Zusammenfassung des gesamten PDFs."
    dialogue, resolved_intent, access, reason = _resolve(message)
    assert reason is AccessResolutionReason.NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT  # confirms the bug would fire

    corrected_access, corrected_reason = correct_full_document_scope_false_positive(
        resolved_access=access, resolution_reason=reason,
        resolved_intent=resolved_intent, dialogue=dialogue,
    )
    assert corrected_access is ResolvedDocumentAccess.RELEVANCE
    assert corrected_reason is AccessResolutionReason.POLICY_OVERRIDE


def test_genuine_full_document_request_still_works():
    message = "Please read the entire PDF and summarize the whole document for me."
    dialogue, resolved_intent, access, reason = _resolve(message)
    assert access is ResolvedDocumentAccess.FULL_DOCUMENT

    corrected_access, corrected_reason = correct_full_document_scope_false_positive(
        resolved_access=access, resolution_reason=reason,
        resolved_intent=resolved_intent, dialogue=dialogue,
    )
    assert corrected_access is ResolvedDocumentAccess.FULL_DOCUMENT
    assert corrected_reason is reason


def test_explicit_ui_hint_is_never_overridden():
    """An explicit UI toggle is the user's own choice, never a lexical
    guess -- this function must never touch it, even if the message text
    would otherwise look like a correction/rejection."""
    from app.services.grounding_contract import RequestedDocumentAccess

    message = "You didn't answer the whole Aufgabe."
    dialogue, resolved_intent, _access, _reason = _resolve(message)
    access, reason = resolve_document_access(
        question=message, requested=RequestedDocumentAccess.FULL_DOCUMENT, viewer_context=None,
    )
    assert reason is AccessResolutionReason.EXPLICIT_UI_HINT

    corrected_access, corrected_reason = correct_full_document_scope_false_positive(
        resolved_access=access, resolution_reason=reason,
        resolved_intent=resolved_intent, dialogue=dialogue,
    )
    assert corrected_access is ResolvedDocumentAccess.FULL_DOCUMENT
    assert corrected_reason is AccessResolutionReason.EXPLICIT_UI_HINT

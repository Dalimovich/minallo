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


_FORGED_TARGET_RESPONSE = {
    "relation": "new_topic", "speechAct": "task_request", "taskFamily": "solve",
    "continuesPreviousGoal": False, "resolvedRequest": "Explain torsion.",
    "confidence": 0.9,
    "conversation": "new", "studentGoal": "Explain torsion.", "responseLanguage": "en",
    "actions": [
        {
            "objective": "solve", "target": "Aufgabe-7-never-mentioned-anywhere",
            "confidence": 0.9, "state": "requested",
            "release": {"final_answer": "permitted"},
        },
    ],
}


def test_model_invented_target_is_never_trusted_or_authorized(monkeypatch):
    """The exact gap unified_semantic_call.py's own docstring and
    test_unified_semantic_call.py::test_unresolved_target_identity_claim_
    is_not_checked_here demonstrate (on purpose, at that lower layer): a
    model can claim target="Aufgabe 7" even though the student only ever
    asked about torsion -- nothing in that validator or in
    validate_action_provenance checks it. This is the orchestrator-level
    regression proving the gate is actually closed at the real entry
    point production calls (interpret_turn_authoritatively), not just
    documented as open. The forged target must downgrade to
    state="unresolved" and come out of compile_policy with the most
    restrictive fallback (final_answer prohibited) -- never "permitted"
    merely because the model said so."""
    client = _FakeClient(_FORGED_TARGET_RESPONSE)
    _patch_model(monkeypatch, client)
    # Quoted/reported speech triggers escalation (needs_semantic_
    # escalation) so this actually exercises the unified-call path the
    # gap lives in — the message itself still never mentions "Aufgabe 7"
    # anywhere, only the mocked model's response invents it.
    message = 'The professor said "skip ahead to the next part" for this one.'
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
    forged_action = result.resolved_intent.actions[0]
    assert forged_action.state == "unresolved"
    policy_action = result.execution_policy.actions[0]
    assert policy_action.target == "Aufgabe-7-never-mentioned-anywhere"
    assert policy_action.release.final_answer == "prohibited"
    assert policy_action.state == "unresolved"
    assert result.execution_policy.needs_clarification is True


def test_a_target_the_student_actually_named_is_still_trusted(monkeypatch):
    """Non-regression: the gate must not catch legitimate targets that
    genuinely appear in the student's own message -- only invented
    ones."""
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

    assert all(a.state != "unresolved" for a in result.resolved_intent.actions)
    targets = {a.target: a for a in result.execution_policy.actions}
    assert targets["5a"].release.final_answer == "permitted"
    assert targets["5b"].release.final_answer == "prohibited"


# ---------------------------------------------------------------------------
# Multi-turn permission persistence (Milestone 3 Priority 1 — fixes the
# gap formerly demonstrated by test_KNOWN_GAP_a_turn_1_prohibition_is_
# not_carried_into_turn_2_by_the_live_orchestrator). policy_compiler.py's
# cross-turn merge logic (rule 2) was already correct in isolation (see
# test_policy_compiler.py::test_earlier_turn_prohibition_then_verified_
# later_turn_permission) -- the orchestrator simply never fed it any
# historical action. It now does: stream.py persists each turn's
# compiled per-target deviations (policy_compiler.extract_persistable_
# restrictions) into that turn's EXISTING ai_tutor_requests.
# request_snapshot ("policyByTarget", via conversation_store.
# update_tutor_request's new compiled_policy_by_target param — no new
# table/migration), and the next turn's interpret_turn_authoritatively
# reconstructs it from the same durable get_messages rows already used
# to build the turn_ledger, merging it in as a trusted historical Action
# before compile_policy runs (semantic_intent_orchestrator.
# _merge_persisted_history).
# ---------------------------------------------------------------------------

def test_turn_1_prohibition_is_carried_into_turn_2_via_persisted_history(monkeypatch):
    """Turn 1: 'Don't reveal the final answer for 5b.' Turn 2 (same
    durable conversation): 'Okay, give me the next hint for 5b.' --
    doesn't repeat the prohibition. Fixed: turn 2 reconstructs turn 1's
    persisted restriction for target '5b' and still withholds the final
    answer."""
    turn_1_response = {
        "relation": "new_topic", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": False, "resolvedRequest": "Don't reveal the final answer for 5b.",
        "confidence": 0.9,
        "conversation": "new", "studentGoal": "Don't reveal the final answer for 5b.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "hint", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {"final_answer": "prohibited", "form": "hint"},
        }],
    }
    client_1 = _FakeClient(turn_1_response)
    _patch_model(monkeypatch, client_1)
    message_1 = 'The professor said "don\'t reveal the final answer" for 5b.'
    dialogue_1 = resolve_dialogue(message_1, previous_turns=[])
    turn_1 = interpret_turn_authoritatively(
        question=message_1, dialogue_base=dialogue_1, preflight_turns=[],
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert turn_1.execution_policy.actions[0].release.final_answer == "prohibited"
    # Exactly what stream.py writes into ai_tutor_requests.request_
    # snapshot.policyByTarget after this turn completes.
    persisted_policy = turn_1.compiled_policy_by_target
    assert persisted_policy["5b"]["final_answer"] == "prohibited"

    turn_2_response = {
        "relation": "continuation", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": True, "resolvedRequest": "Give me the next hint for 5b.",
        "confidence": 0.9,
        "conversation": "follow_up", "studentGoal": "Give me the next hint for 5b.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "hint", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {},  # turn 2 doesn't repeat the prohibition at all
        }],
    }
    client_2 = _FakeClient(turn_2_response)
    _patch_model(monkeypatch, client_2)

    def get_messages_after_turn_1(**_):
        # The join-enriched shape get_durable_conversation_messages
        # actually returns: both rows of the completed request carry the
        # same request_snapshot.
        return [
            {"client_message_id": "turn-1-user", "role": "user", "content": message_1,
             "request_snapshot": {"policyByTarget": persisted_policy}},
            {"client_message_id": "turn-1-assistant", "role": "assistant",
             "content": "Understood, hint-only for 5b.",
             "request_snapshot": {"policyByTarget": persisted_policy}},
        ]

    # "5b" is repeated literally here on purpose: this makes the target-
    # identity gate trust the target normally, so this test isolates the
    # cross-turn persistence question specifically.
    message_2 = 'Okay, "give me the next hint" for 5b then.'
    dialogue_2 = resolve_dialogue(message_2, previous_turns=[
        {"role": "user", "text": message_1}, {"role": "assistant", "text": "Understood, hint-only for 5b."},
    ])
    turn_2 = interpret_turn_authoritatively(
        question=message_2, dialogue_base=dialogue_2, preflight_turns=[],
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=get_messages_after_turn_1,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert turn_2.resolved_intent.actions[0].state != "unresolved", (
        "'5b' is named literally in message_2, so the (separately tested) "
        "target-identity gate must trust it here"
    )
    assert turn_2.execution_policy.actions[0].release.final_answer == "prohibited"
    assert turn_2.execution_policy.actions[0].release.form == "hint"


def test_verified_later_turn_can_explicitly_lift_a_persisted_prohibition(monkeypatch):
    """A genuine, trusted current-turn instruction ('actually, go ahead
    and give me the full answer for 5b now') must still be able to
    override a persisted prior-turn prohibition -- persistence must never
    become a one-way ratchet. The current turn's own action always
    outranks history (compile_policy's existing recency rule: the
    current turn's rank is never beaten by any verified prior turn)."""
    persisted_policy = {"5b": {"final_answer": "prohibited", "form": "hint"}}

    def get_messages_with_prior_restriction(**_):
        return [{"client_message_id": "turn-1", "role": "user", "content": "...",
                  "request_snapshot": {"policyByTarget": persisted_policy}}]

    response = {
        "relation": "correction", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": True, "resolvedRequest": "Actually give the full answer for 5b.",
        "confidence": 0.9,
        "conversation": "permission_update", "studentGoal": "Actually give the full answer for 5b.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "solve", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {"final_answer": "permitted"},
        }],
    }
    client = _FakeClient(response)
    _patch_model(monkeypatch, client)
    message = 'Actually, "go ahead and show me the full answer" for 5b now.'
    dialogue = resolve_dialogue(message, previous_turns=[])

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=get_messages_with_prior_restriction,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert result.execution_policy.actions[0].release.final_answer == "permitted"


def test_unverifiable_history_degrades_to_restrictive_never_to_permitted(monkeypatch):
    """A durable conversation_id is supplied (the client believes there
    is history) but the lookup itself fails (DB hiccup, not merely 'no
    history yet') -- requirement 7: this must never be silently treated
    as a blank slate that defaults a withheld field open."""
    response = {
        "relation": "continuation", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": True, "resolvedRequest": "Give me the next hint for 5b.",
        "confidence": 0.9,
        "conversation": "follow_up", "studentGoal": "Give me the next hint for 5b.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "hint", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {},
        }],
    }
    client = _FakeClient(response)
    _patch_model(monkeypatch, client)
    message = 'Okay, "give me the next hint" for 5b then.'
    dialogue = resolve_dialogue(message, previous_turns=[
        {"role": "user", "text": "earlier turn"}, {"role": "assistant", "text": "..."},
    ])

    def get_messages_raises(**_):
        raise RuntimeError("supabase unreachable")

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=get_messages_raises,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert result.execution_policy.actions[0].release.final_answer == "prohibited"
    assert result.execution_policy.needs_clarification is True


def test_cross_user_history_is_never_read_or_merged(monkeypatch):
    """Ownership denial must stop history lookup cold -- a different
    user's (or a no-longer-owned) conversation's persisted policy must
    never even be read, let alone merged in."""
    calls = []

    def get_messages_tracks(**_):
        calls.append(True)
        return [{"client_message_id": "other-users-turn", "role": "user", "content": "...",
                  "request_snapshot": {"policyByTarget": {"5b": {"final_answer": "prohibited"}}}}]

    response = {
        "relation": "new_topic", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": False, "resolvedRequest": "Give me the full answer for 5b.",
        "confidence": 0.9, "conversation": "new", "studentGoal": "Give me the full answer for 5b.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "solve", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {},
        }],
    }
    client = _FakeClient(response)
    _patch_model(monkeypatch, client)
    message = 'Please "give me the full answer" for 5b.'
    dialogue = resolve_dialogue(message, previous_turns=[])

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-2", conversation_id="conv-owned-by-someone-else",
        validate_ownership=lambda **_: False, get_messages=get_messages_tracks,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert calls == [], "get_messages must never be called once ownership fails"
    assert result.execution_policy.actions[0].release.final_answer == "prohibited"
    assert result.execution_policy.needs_clarification is True


def test_exercise_switch_does_not_inherit_a_different_targets_restriction(monkeypatch):
    """Switching to a different exercise must never inherit an unrelated
    exercise's persisted restriction -- matching is exact-target-string
    only, never a label-hierarchy guess at the history-replay layer."""
    persisted_policy = {"5a": {"final_answer": "prohibited"}}

    def get_messages_with_prior_restriction(**_):
        return [{"client_message_id": "turn-1", "role": "user", "content": "...",
                  "request_snapshot": {"policyByTarget": persisted_policy}}]

    response = {
        "relation": "new_topic", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": False, "resolvedRequest": "Now let's do 6.",
        "confidence": 0.9, "conversation": "exercise_switch", "studentGoal": "Now let's do 6.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "solve", "target": "6", "confidence": 0.9, "state": "requested",
            "release": {},
        }],
    }
    client = _FakeClient(response)
    _patch_model(monkeypatch, client)
    message = 'Let\'s switch, "do exercise 6" now.'
    dialogue = resolve_dialogue(message, previous_turns=[])

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=get_messages_with_prior_restriction,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert result.execution_policy.actions[0].target == "6"
    assert result.execution_policy.actions[0].release.final_answer == "permitted"


def test_no_conversation_id_skips_history_merge_entirely(monkeypatch):
    """Legacy/non-durable-chat parity: a turn with no conversation_id at
    all must behave exactly as before -- no sentinel, no replay, no
    needs_clarification side effect, even though a persisted restriction
    for the same target exists on some OTHER call's injected get_
    messages (which must never even be consulted here, since the real
    production call site only passes a conversation_id for durable
    chats)."""
    response = {
        "relation": "new_topic", "speechAct": "task_request", "taskFamily": "solve",
        "continuesPreviousGoal": False, "resolvedRequest": "Give me the full answer for 5b.",
        "confidence": 0.9, "conversation": "new", "studentGoal": "Give me the full answer for 5b.",
        "responseLanguage": "en",
        "actions": [{
            "objective": "solve", "target": "5b", "confidence": 0.9, "state": "requested",
            "release": {},
        }],
    }
    client = _FakeClient(response)
    _patch_model(monkeypatch, client)
    message = 'Please "give me the full answer" for 5b.'
    dialogue = resolve_dialogue(message, previous_turns=[])

    def _must_not_be_called(**_):
        raise AssertionError("must not be called when conversation_id is None")

    result = interpret_turn_authoritatively(
        question=message, dialogue_base=dialogue, preflight_turns=[],
        user_id="user-1", conversation_id=None,
        validate_ownership=_must_not_be_called, get_messages=_must_not_be_called,
        resolved_access=ResolvedDocumentAccess.RELEVANCE, has_visible_context=False,
    )
    assert result.execution_policy.actions[0].release.final_answer == "permitted"
    assert result.execution_policy.needs_clarification is False


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

"""Tests for app/services/diagnostic_policy.py — Milestone 3 PR 1,
strictly behavior-inert.

Every conversation_store call is mocked (never a real Supabase/DB call).
Zero real model/network calls — this module makes none, and a test here
greps its own source to prove it. These are CONTRACT tests: they prove
the code handles given shapes correctly, never that a real model would
produce them (there is no model in this module at all).
"""

import inspect
import pathlib

import pytest

from app.services.diagnostic_policy import (
    adapt_deterministic_intent,
    build_turn_ledger_from_durable_store,
    compile_diagnostic_policy,
    resolve_target_identity,
)
from app.services.dialogue_state import resolve_dialogue
from app.services.student_intent import interpret_student_intent
from app.services.grounding_contract import ResolvedDocumentAccess


# ---------------------------------------------------------------------------
# resolve_target_identity — positive, negative, forged, correction, multi.
# ---------------------------------------------------------------------------

def test_positive_target_literally_in_message():
    assert resolve_target_identity("Aufgabe 7", original_message="Explain Aufgabe 7 for me.") is True


def test_negative_target_not_mentioned_anywhere():
    assert resolve_target_identity(
        "Aufgabe 7", original_message="Explain torsion.",
    ) is False


def test_forged_reference_target_is_not_accepted():
    """The exact gap the prior review demonstrated: a plausible-looking
    but fabricated target must not validate just because it looks like a
    real exercise label."""
    assert resolve_target_identity(
        "Aufgabe-7-never-mentioned-anywhere", original_message="Explain torsion.",
    ) is False


def test_correction_target_recognized_via_literal_mention():
    """"I meant 5b, not 5a." — "5b" is literally present in the message,
    so it resolves without needing any special-cased correction logic."""
    assert resolve_target_identity("5b", original_message="I meant 5b, not 5a.") is True


def test_multi_exercise_targets_both_independently_resolve():
    message = "Keine Lösung für Aufgabe 5. Aber für Aufgabe 6 will ich die vollständige Musterlösung."
    assert resolve_target_identity("Aufgabe 5", original_message=message) is True
    assert resolve_target_identity("Aufgabe 6", original_message=message) is True
    assert resolve_target_identity("Aufgabe 9", original_message=message) is False


def test_verified_active_question_resolves_even_without_literal_mention():
    """A target matching the DETERMINISTIC layer's own already-resolved
    active_question is trusted — it did not come from a model."""
    assert resolve_target_identity(
        "4.2", original_message="Can I get a hint?", verified_active_question="4.2",
    ) is True


def test_authorized_exercise_label_resolves_without_literal_mention():
    assert resolve_target_identity(
        "3a", original_message="Can I get a hint?",
        authorized_exercise_labels=frozenset({"3a", "3b"}),
    ) is True


def test_empty_claimed_target_never_resolves():
    assert resolve_target_identity("", original_message="anything") is False
    assert resolve_target_identity("   ", original_message="anything") is False


def test_sub_label_of_verified_active_question_resolves_without_literal_mention():
    """Regression for the live eval's document-scope-correction-not-
    full-document case: 'you didn't answer parts a and c' never literally
    says '5a'/'5c', only the already-verified active_question '5'. A
    strict, well-formed sub-label of a TRUSTED active_question is no less
    trustworthy than the exercise itself (same canonical label grammar
    policy_compiler's rule 4 already uses for narrower-inherits-from-
    broader, reused via is_narrower_exercise_label)."""
    assert resolve_target_identity(
        "5a", original_message="You didn't answer everything.", verified_active_question="5",
    ) is True
    assert resolve_target_identity(
        "5c", original_message="You didn't answer everything.", verified_active_question="5",
    ) is True


def test_target_broader_than_or_unrelated_to_active_question_still_does_not_resolve():
    """Non-regression: only a STRICT NARROWING of the verified
    active_question is trusted -- never the reverse (a broader claim),
    and never an unrelated sibling label that merely shares a leading
    digit."""
    assert resolve_target_identity(
        "5", original_message="Give me everything.", verified_active_question="5a",
    ) is False
    assert resolve_target_identity(
        "50", original_message="Give me everything.", verified_active_question="5",
    ) is False


# ---------------------------------------------------------------------------
# build_turn_ledger_from_durable_store — mocked conversation_store only.
# ---------------------------------------------------------------------------

def test_no_conversation_id_is_explicitly_history_free():
    result = build_turn_ledger_from_durable_store(
        user_id="u1", conversation_id=None,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    assert result.source == "history_free"
    assert result.ledger is None


def test_no_conversation_id_with_unverified_context_is_unavailable_not_history_free():
    """A course-rail-style request with no durable conversationId but a
    client-supplied one and/or previousTurns is NOT genuinely history-free
    — the caller signals that with has_unverified_context=True, and this
    must never fall back to reading those client-supplied turns itself."""
    result = build_turn_ledger_from_durable_store(
        user_id="u1", conversation_id=None, has_unverified_context=True,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    assert result.source == "unavailable"
    assert result.ledger is None


def test_ownership_failure_is_unavailable_not_a_fallback():
    result = build_turn_ledger_from_durable_store(
        user_id="u1", conversation_id="conv-1",
        validate_ownership=lambda **_: False, get_messages=lambda **_: [{"client_message_id": "m1"}],
    )
    assert result.source == "unavailable"
    assert result.ledger is None  # never falls back to the (unused) rows


def test_lookup_exception_degrades_to_unavailable_not_a_raise():
    def _boom(**_kwargs):
        raise RuntimeError("supabase unreachable")

    result = build_turn_ledger_from_durable_store(
        user_id="u1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=_boom,
    )
    assert result.source == "unavailable"
    assert result.ledger is None


def test_successful_lookup_builds_a_real_ledger():
    rows = [
        {"client_message_id": "m1", "created_at": "2026-01-01T00:00:00Z", "role": "user", "content": "hi"},
        {"client_message_id": "m2", "created_at": "2026-01-01T00:00:01Z", "role": "assistant", "content": "hello"},
    ]
    result = build_turn_ledger_from_durable_store(
        user_id="u1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=lambda **_: rows,
    )
    assert result.source == "durable_store"
    assert result.ledger is not None
    assert result.ledger.conversation_id == "conv-1"
    assert {t.turn_id for t in result.ledger.turns} == {"m1", "m2"}


def test_empty_but_owned_conversation_is_an_explicit_empty_ledger_not_unavailable():
    """Ownership verified, zero rows (e.g. a brand new conversation) —
    this is TurnLedger.empty-shaped, not "unavailable"; the two are
    deliberately distinct per Decision 2."""
    result = build_turn_ledger_from_durable_store(
        user_id="u1", conversation_id="conv-1",
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    assert result.source == "durable_store"
    assert result.ledger is not None
    assert result.ledger.turns == ()


# ---------------------------------------------------------------------------
# adapt_deterministic_intent — deterministic-only, no model call.
# ---------------------------------------------------------------------------

def _student_intent(message, **overrides):
    dialogue = resolve_dialogue(message, previous_turns=[])
    intent = interpret_student_intent(
        message, dialogue=dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE, mode="off",
    )
    return dialogue, intent


def test_adapt_maps_primary_task_to_objective():
    dialogue, intent = _student_intent("Summarize chapter 3 briefly.")
    resolved = adapt_deterministic_intent(message="Summarize chapter 3 briefly.", dialogue=dialogue, student_intent=intent)
    assert resolved.actions[0].objective == "summarize"


def test_adapt_unresolved_exercise_reference_produces_unresolved_state():
    """An answer-bearing objective (here "solve", via a math-shaped
    message) with no resolvable exercise label must still be
    "unresolved" -- unchanged by the 2026-10-21 production fix below,
    which only exempts objectives with no exercise-answer concept at
    all."""
    dialogue, intent = _student_intent("Solve this for me.")
    resolved = adapt_deterministic_intent(message="Solve this for me.", dialogue=dialogue, student_intent=intent)
    assert resolved.actions[0].objective == "solve"
    assert resolved.actions[0].state == "unresolved"
    assert resolved.actions[0].target == "current_request"


def test_adapt_unresolved_content_explanation_is_requested_not_unresolved():
    """Confirmed production defect (2026-10-21): "Explain this to me."
    on an ordinary, non-exercise document used to come out "unresolved"
    here (there is no numbered exercise label to resolve against), which
    forced policy_compiler's most-restrictive exercise-answer fallback
    (form="hint", explanation_depth="none", final_answer prohibited) onto
    an ordinary document-explanation request -- see docs/... and this
    module's own _OBJECTIVES_WITHOUT_EXERCISE_IDENTITY comment. "explain"
    has no exercise-answer-disclosure concept, so a missing exercise
    label must not make it "unresolved" -- it is requested, with a
    content-scope (not exercise-identity) target placeholder."""
    dialogue, intent = _student_intent("Explain this to me.")
    resolved = adapt_deterministic_intent(message="Explain this to me.", dialogue=dialogue, student_intent=intent)
    assert resolved.actions[0].objective == "explain"
    assert resolved.actions[0].state == "requested"
    assert resolved.actions[0].target == "current_request"


def test_adapt_maps_quiz_generation_to_hint_objective_ab24_backstop():
    """AB-24 policy-layer follow-up: once answer_intent.py's _QUIZ_RE fix
    classifies "Frag mich die Lagerkraft R_A ab." as QUIZ_GENERATION, the
    deterministic adapter must map it to objective="hint" (not the
    "other" default) so policy_compiler's existing hint-objective
    fallback closes final_answer, independent of whatever generation-
    side quiz mechanism handles the actual interactive experience."""
    message = "Frag mich die Lagerkraft R_A ab."
    dialogue, intent = _student_intent(message)
    resolved = adapt_deterministic_intent(message=message, dialogue=dialogue, student_intent=intent)
    assert resolved.actions[0].objective == "hint"


def test_adapt_with_no_student_intent_still_produces_a_valid_shape():
    dialogue = resolve_dialogue("Explain torsion.", previous_turns=[])
    resolved = adapt_deterministic_intent(message="Explain torsion.", dialogue=dialogue, student_intent=None)
    assert resolved.actions[0].objective == "other"


def test_adapt_relation_maps_to_conversation_shape():
    dialogue = resolve_dialogue("go ahead", previous_turns=[
        {"role": "assistant", "text": "Should I continue?"},
    ])
    resolved = adapt_deterministic_intent(message="go ahead", dialogue=dialogue, student_intent=None)
    assert resolved.conversation in {"new", "follow_up", "correction", "rejection", "exercise_switch", "permission_update"}


# ---------------------------------------------------------------------------
# compile_diagnostic_policy — the full pipeline, mocked DB only.
# ---------------------------------------------------------------------------

def test_full_pipeline_with_no_conversation_id():
    dialogue, intent = _student_intent("Explain torsion.")
    policy, record = compile_diagnostic_policy(
        message="Explain torsion.", dialogue=dialogue, student_intent=intent,
        user_id="u1", conversation_id=None,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    assert record.history_source == "history_free"
    assert isinstance(record.policy_hash, str) and record.policy_hash


def test_full_pipeline_with_unverified_context_and_no_conversation_id():
    """The course-rail case end to end: no durable conversation_id, but
    the caller flags unverified context — diagnosed "unavailable", never
    "history_free". has_unverified_context only changes this label; the
    actual compiled policy is unaffected (no ledger either way)."""
    dialogue, intent = _student_intent("Explain torsion.")
    unverified_policy, unverified_record = compile_diagnostic_policy(
        message="Explain torsion.", dialogue=dialogue, student_intent=intent,
        user_id="u1", conversation_id=None, has_unverified_context=True,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    free_policy, free_record = compile_diagnostic_policy(
        message="Explain torsion.", dialogue=dialogue, student_intent=intent,
        user_id="u1", conversation_id=None, has_unverified_context=False,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    assert unverified_record.history_source == "unavailable"
    assert free_record.history_source == "history_free"
    assert unverified_policy == free_policy


def test_full_pipeline_is_pure_and_deterministic():
    dialogue, intent = _student_intent("Explain torsion.")
    kwargs = dict(
        message="Explain torsion.", dialogue=dialogue, student_intent=intent,
        user_id="u1", conversation_id=None,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    policy1, record1 = compile_diagnostic_policy(**kwargs)
    policy2, record2 = compile_diagnostic_policy(**kwargs)
    assert policy1 == policy2
    assert record1 == record2


def test_diagnostic_record_never_contains_free_text():
    """Privacy guard: every field on DiagnosticPolicyRecord must be an
    enum/count/hash, never the message or any free text."""
    dialogue, intent = _student_intent("My secret essay content should never leak.")
    policy, record = compile_diagnostic_policy(
        message="My secret essay content should never leak.", dialogue=dialogue, student_intent=intent,
        user_id="u1", conversation_id=None,
        validate_ownership=lambda **_: True, get_messages=lambda **_: [],
    )
    for value in record.__dict__.values():
        assert "secret essay" not in str(value)


# ---------------------------------------------------------------------------
# Behavior-inertness guards.
# ---------------------------------------------------------------------------

_BACKEND_ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_module_makes_no_model_calls():
    """Greps this module's own source — no openai client, no chat
    completion call, anywhere. The diagnostic policy is built entirely
    from data already computed deterministically today."""
    source = pathlib.Path(inspect.getfile(compile_diagnostic_policy)).read_text(encoding="utf-8")
    assert "openai_client" not in source
    assert "chat.completions" not in source
    assert "get_openai_client" not in source


@pytest.mark.parametrize("consumer_file", [
    "app/routers/ask.py",
    "app/services/answer.py",
    "app/services/answer_stream.py",
    "app/services/general_answer.py",
    "app/services/visual_repair.py",
    "app/services/cache.py",
    "app/services/course_grounding.py",
])
def test_diagnostic_policy_never_reaches_a_live_consumer(consumer_file):
    """Milestone 3 PR 2 intentionally wires app/routers/stream.py to this
    module (see test_stream_semantic_intent_diagnostic_wiring.py) — it is
    no longer in this list. Every OTHER consumer that could actually
    affect a response — generation, grounding, cache, verification,
    repair — must still never import diagnostic_policy at all."""
    text = (_BACKEND_ROOT / consumer_file).read_text(encoding="utf-8")
    assert "diagnostic_policy" not in text


def test_stream_router_diagnostic_call_result_is_always_discarded():
    """The one approved consumer (app/routers/stream.py) may call into this
    module, but only through _run_semantic_intent_diagnostic_policy, whose
    return type is None and which is only ever reached via
    _schedule_semantic_intent_diagnostic_policy's bare, unawaited
    `asyncio.create_task(...)` call site in ask_stream_endpoint —
    structurally, nothing it computes can reach resolve_execution_plan,
    generation, grounding, verification, repair, or cache, and it cannot
    delay the response either, since the route never awaits it. This
    greps the real source rather than just asserting the convention, so a
    future edit that starts assigning/forwarding the result, or awaiting
    it inline again, breaks this test immediately."""
    source = (_BACKEND_ROOT / "app/routers/stream.py").read_text(encoding="utf-8")
    assert "from ..services.diagnostic_policy import compile_diagnostic_policy" in source
    assert "_schedule_semantic_intent_diagnostic_policy(\n" in source
    assert "await _schedule_semantic_intent_diagnostic_policy" not in source
    assert "await _run_semantic_intent_diagnostic_policy" not in source
    for line in source.splitlines():
        stripped = line.strip()
        if (
            "_schedule_semantic_intent_diagnostic_policy" in stripped
            or "_run_semantic_intent_diagnostic_policy" in stripped
        ) and stripped.startswith(("=", "return")):
            raise AssertionError(f"diagnostic result must never be assigned/returned: {stripped!r}")

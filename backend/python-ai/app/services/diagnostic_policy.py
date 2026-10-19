"""Milestone 3 — strictly behavior-inert observational diagnostics.

Computes an ``ExecutionPolicy`` from EXISTING, already-gathered
deterministic data (today's `resolve_dialogue`/`StudentIntent` fields) for
DIAGNOSTIC COMPARISON ONLY. Never consumed by generation, routing,
caching, or authorization.

PR 1 kept this module entirely unwired (nothing imported it). PR 2 wires
it into ``app/routers/stream.py``'s ``ask_stream_endpoint`` — see
``_record_semantic_intent_diagnostic_policy`` there — as the one approved
observational call site: it only ever logs a privacy-safe record, its
result is a bare unassigned ``await``, and it runs under a try/except
that can never propagate into the real response. Every OTHER consumer
that could actually affect a response — ``app/routers/ask.py``,
``app/services/answer.py``, ``app/services/answer_stream.py``,
``app/services/general_answer.py``, ``app/services/visual_repair.py``,
``app/services/cache.py``, ``app/services/course_grounding.py`` — still
never imports this module at all (``test_diagnostic_policy_never_
reaches_a_live_consumer`` asserts this directly against the actual
module source, not just by convention; ``test_stream_router_diagnostic_
call_result_is_always_discarded`` asserts the stream.py call site itself
never assigns/forwards the result).

No new model call. The tension between "diagnostic comparison" and "no
new live calls" is resolved by building the diagnostic
``ResolvedStudentIntent`` from data ALREADY computed today by the
deterministic layer alone (``DialogueResolution``/``StudentIntent``,
``interpretation_source="deterministic"`` or ``"fallback"`` — never
``"semantic_model"``) — this module makes zero OpenAI/model calls of its
own, and a test (``test_module_makes_no_model_calls``) greps its own
source for that. A real held-out comparison against the SEMANTIC path
(call #1/#2 or the unified call) is explicitly future, separately-
approved, offline/log-replay work — not built here (see
``docs/semantic-intent-milestone-3-plan.md`` §2/§8).

Three pieces:

1. ``resolve_target_identity`` — closes the gap the previous round's
   review found and demonstrated with a test
   (``test_unresolved_target_identity_claim_is_not_checked_here`` in
   ``test_unified_semantic_call.py``): a claimed exercise/target string is
   grounded against (a) the literal current message, (b) the
   deterministic layer's own already-resolved ``active_question``
   (trusted — it is not model output), (c) a caller-supplied set of
   authorized exercise labels (e.g. from trusted viewer/document
   metadata — NEVER retrieved document text, never raw model output).
   Never guesses; an unresolved target is recorded as such.
2. ``build_turn_ledger_from_durable_store`` — wraps
   ``conversation_store.validate_durable_conversation`` +
   ``get_durable_conversation_messages`` (the real, already-shipped,
   ownership-verified persistence layer — see
   ``docs/semantic-intent-milestone-3-plan.md`` §4) into a
   ``TurnLedger``. Never builds one from ``payload.previousTurns``.
3. ``adapt_deterministic_intent`` + ``compile_diagnostic_policy`` — a
   best-effort, lossy, DIAGNOSTIC-ONLY adapter from today's deterministic
   ``StudentIntent``/``DialogueResolution`` into one ``Action``/
   ``ResolvedStudentIntent``, then through the real, already-tested
   ``compile_policy``. The mapping tables below are intentionally
   approximate — good enough to exercise the compiler/ledger/target-
   identity machinery against real conversation shapes, not a claim of
   semantic accuracy.

``to_diagnostic_record`` is the only thing ever logged: counts, enums,
and the ``policy_hash`` — never the student's message, never document
content, never free text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from .answer_intent import AcademicIntent
from .dialogue_state import DialogueResolution, TurnRelation
from .policy_compiler import ExecutionPolicy, compile_policy, is_narrower_exercise_label
from .resolved_student_intent import (
    Action,
    ConversationShape,
    ExplanationDepth,
    Objective,
    ReleaseConstraints,
    ResolvedStudentIntent,
    TurnLedger,
)
from .student_intent import StudentIntent

DIAGNOSTIC_SCHEMA_VERSION = "1.0.0"
HistorySource = Literal["durable_store", "history_free", "unavailable"]


# ---------------------------------------------------------------------------
# 1. Target identity resolution — the demonstrated gap, closed.
# ---------------------------------------------------------------------------

def resolve_target_identity(
    claimed_target: str,
    *,
    original_message: str,
    verified_active_question: str | None = None,
    authorized_exercise_labels: frozenset[str] = frozenset(),
) -> bool:
    """True only if ``claimed_target`` can be grounded in trusted context:

    - it matches the deterministic layer's own already-resolved
      ``active_question`` (trusted — produced by ``resolve_dialogue``'s
      lexical layer, never by a model), or it is a strict, well-formed
      SUB-LABEL of that active_question (e.g. claimed "5a" when
      active_question is "5") — the model is still not trusted to
      invent the target from nothing, but a narrower part of an
      already-verified, deterministically-resolved exercise is no less
      trustworthy than the exercise itself (same canonical label grammar
      policy_compiler's rule 4 already uses for "narrower target
      inherits from broader parent", reused here via
      ``is_narrower_exercise_label`` rather than re-implemented) — this
      is what lets "you didn't answer parts a and c of [the already-
      active exercise]" correctly resolve to grounded "5a"/"5c" actions
      instead of being discarded as unresolved, or
    - it is in ``authorized_exercise_labels`` (a caller-supplied,
      pre-authorized set — e.g. known exercise labels for the open
      document; NEVER retrieved document TEXT, which is evidence for
      answering, not for interpreting what the student means — same
      invariant ``student_intent.py`` already documents), or
    - it appears as a whole-word token in the literal current message.

    Never uses raw model output to authorize itself — this function
    takes no model-sourced input at all. An unresolved target returns
    False; the caller (``adapt_deterministic_intent``) records that as
    ``state="unresolved"``, never a guess.
    """
    claimed = (claimed_target or "").strip().lower()
    if not claimed:
        return False
    if verified_active_question:
        active = verified_active_question.strip().lower()
        if claimed == active or is_narrower_exercise_label(claimed, active):
            return True
    if claimed in {label.strip().lower() for label in authorized_exercise_labels}:
        return True
    return bool(re.search(rf"\b{re.escape(claimed)}\b", original_message or "", re.IGNORECASE))


# ---------------------------------------------------------------------------
# 2. Trusted turn ledger — from the real durable store, never from
#    payload.previousTurns. conversation_store calls are injected so
#    tests never touch a real database.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DurableHistoryResult:
    ledger: TurnLedger | None
    source: HistorySource


def build_turn_ledger_from_durable_store(
    *,
    user_id: str,
    conversation_id: str | None,
    validate_ownership: Any,
    get_messages: Any,
    has_unverified_context: bool = False,
) -> DurableHistoryResult:
    """``validate_ownership``/``get_messages`` are
    ``conversation_store.validate_durable_conversation``/``get_durable_
    conversation_messages`` — injected (not imported at module scope and
    called directly) so every test here mocks the boundary explicitly,
    the same pattern the rest of this codebase's DB-adjacent tests use,
    and so this module never accidentally gains a hard import-time
    dependency on Supabase being configured.

    Returns ``source="history_free"`` only when no ``conversation_id``
    was given AND the caller has no other unverified context either
    (``has_unverified_context=False``) — a request genuinely known to
    have no historical dependency at all. A non-durable request that
    still carries its own ``conversationId`` and/or client-supplied
    ``previousTurns`` is NOT history-free — the caller should pass
    ``has_unverified_context=True`` for it, which this function reports
    as ``source="unavailable"`` instead, without ever reading those
    client-supplied turns into the ledger.

    Returns ``source="unavailable"`` when a ``conversation_id`` WAS given
    but ownership fails to verify, or the lookup itself raises — in
    neither case does this fall back to any client-supplied substitute;
    "unavailable" is itself the safe, explicit diagnostic state (see
    ``docs/semantic-intent-milestone-3-plan.md`` §4's lifecycle
    investigation for why a successful-looking lookup must still not be
    assumed complete, and this module's own docstring for why that
    caveat does not change what this function returns — completeness
    beyond "ownership verified" is a product-lifecycle question, not
    something this pure function can detect)."""
    if not conversation_id:
        return DurableHistoryResult(
            ledger=None,
            source="unavailable" if has_unverified_context else "history_free",
        )
    try:
        owned = validate_ownership(user_id=user_id, conversation_id=conversation_id)
    except Exception:  # noqa: BLE001 — a lookup failure must degrade safely, never raise into the caller
        return DurableHistoryResult(ledger=None, source="unavailable")
    if not owned:
        return DurableHistoryResult(ledger=None, source="unavailable")
    try:
        rows = get_messages(user_id=user_id, conversation_id=conversation_id)
    except Exception:  # noqa: BLE001
        return DurableHistoryResult(ledger=None, source="unavailable")
    turns = {
        str(row.get("client_message_id") or f"row-{index}"): row
        for index, row in enumerate(rows or [])
    }
    return DurableHistoryResult(
        ledger=TurnLedger.build(conversation_id=conversation_id, turns=turns),
        source="durable_store",
    )


# ---------------------------------------------------------------------------
# 3. Deterministic-only adapter: StudentIntent/DialogueResolution ->
#    ResolvedStudentIntent. Best-effort, lossy, diagnostic only.
# ---------------------------------------------------------------------------

_ACADEMIC_INTENT_TO_OBJECTIVE: Mapping[AcademicIntent, Objective] = {
    AcademicIntent.CONCEPTUAL_EXPLANATION: "explain",
    AcademicIntent.DEFINITION_OR_THEOREM: "define",
    AcademicIntent.MATH_PROBLEM: "solve",
    AcademicIntent.MIXED_MATH_AND_CONCEPT: "solve",
    AcademicIntent.CODE_PROBLEM: "solve",
    AcademicIntent.ANSWER_CORRECTION_OR_GRADING: "review_student_solution",
    AcademicIntent.EXAM_GENERATION: "exam_practice",
    AcademicIntent.PRACTICE_VARIANT_GENERATION: "exam_practice",
    AcademicIntent.COMPARISON: "compare",
    AcademicIntent.MULTI_SOURCE_COMPARISON: "compare",
    AcademicIntent.COURSE_SUMMARY: "summarize",
    AcademicIntent.COMPLETE_NOTES: "summarize",
    AcademicIntent.TRANSLATION: "translate",
    AcademicIntent.GENERAL_COURSE_QA: "answer_subquestion",
}

_DEPTH_TO_EXPLANATION_DEPTH: Mapping[str, ExplanationDepth] = {
    "one_step": "method",
    "brief": "concept",
    "first_time_learner": "concept",
    "detailed": "worked_derivation",
    # "normal" deliberately absent -> "unspecified", letting compile_policy's
    # own tutoring default apply, same as any other unaddressed field.
}

_RELATION_TO_CONVERSATION: Mapping[TurnRelation, ConversationShape] = {
    TurnRelation.NEW_TOPIC: "new",
    TurnRelation.CONTINUATION: "follow_up",
    TurnRelation.ANSWER_TO_ASSISTANT: "follow_up",
    TurnRelation.CLARIFICATION: "follow_up",
    TurnRelation.CORRECTION: "correction",
    TurnRelation.REJECTION: "rejection",
    TurnRelation.CONFIRMATION: "follow_up",
    TurnRelation.DELEGATION: "follow_up",
    TurnRelation.AMBIGUOUS: "new",  # safest: no special cross-turn override privilege without a clear signal
}


def adapt_deterministic_intent(
    *,
    message: str,
    dialogue: DialogueResolution,
    student_intent: StudentIntent | None,
    authorized_exercise_labels: frozenset[str] = frozenset(),
) -> ResolvedStudentIntent:
    """Best-effort, diagnostic-only projection of today's deterministic
    output into the canonical multi-action shape. Does NOT invoke any
    model — ``student_intent`` here is expected to already be
    ``interpretation_source in {"deterministic", "fallback"}`` (the
    caller's responsibility; this function does not check it, since it
    has no opinion on whether a caller passes a semantic-model-backed
    ``StudentIntent`` in — doing so would just mean the diagnostic
    reflects what was ALREADY computed today in SHADOW/ENABLED mode,
    still zero new calls either way)."""
    target = dialogue.active_question or ""
    # A genuinely NEW, unrelated topic (relation=NEW_TOPIC) must never
    # silently inherit a stale active_question that only survives
    # because dialogue_state._active_questions deliberately keeps
    # scanning history for CONTINUATIONS — that fallback is exactly
    # wrong once the student has moved to an unrelated question. The
    # check below (``resolve_target_identity``) would otherwise be
    # circular for this case: target was just set FROM active_question,
    # so it trivially "matches" it, regardless of whether THIS message
    # has anything to do with it. A fresh, same-turn label is unaffected
    # — if the CURRENT message itself names this target (e.g. "let's
    # switch to exercise 9 instead" is also NEW_TOPIC but legitimately
    # about "9"), the literal-token-match branch below still proves it.
    # Confirmed live, 2026-10-20 eval case "unrelated-followup-no-
    # restriction-inheritance" (an unrelated general-knowledge follow-up
    # right after a hint-only exchange wrongly inherited that exercise's
    # restriction).
    if (
        dialogue.relation is TurnRelation.NEW_TOPIC
        and target
        and not re.search(rf"\b{re.escape(target)}\b", message or "", re.IGNORECASE)
    ):
        target = ""
    target_resolved = bool(target) and resolve_target_identity(
        target, original_message=message, verified_active_question=dialogue.active_question,
        authorized_exercise_labels=authorized_exercise_labels,
    )
    if not target:
        target = "current_request"  # explicit, unresolved placeholder — never a guessed label
        target_resolved = False

    objective: Objective = "other"
    prohibited: tuple[str, ...] = ()
    explanation_depth: ExplanationDepth = "unspecified"
    final_answer: Literal["permitted", "prohibited", "unspecified"] = "unspecified"
    if student_intent is not None:
        objective = _ACADEMIC_INTENT_TO_OBJECTIVE.get(student_intent.primary_task, "other")
        prohibited = tuple(dict.fromkeys(
            _ACADEMIC_INTENT_TO_OBJECTIVE.get(task, "other") for task in student_intent.prohibited_tasks
        ))
        explanation_depth = _DEPTH_TO_EXPLANATION_DEPTH.get(student_intent.depth, "unspecified")
        if student_intent.primary_task in student_intent.prohibited_tasks:
            final_answer = "prohibited"  # self-contradictory deterministic signal — be conservative, not permissive

    action = Action(
        objective=objective, target=target,
        release=ReleaseConstraints(final_answer=final_answer, explanation_depth=explanation_depth),
        prohibited=prohibited,
        state="requested" if target_resolved else "unresolved",
    )
    conversation = _RELATION_TO_CONVERSATION.get(dialogue.relation, "new")
    return ResolvedStudentIntent(
        schema_version=DIAGNOSTIC_SCHEMA_VERSION,
        original_message=message,
        student_goal=dialogue.resolved_request or message,
        actions=(action,),
        conversation=conversation,
        references=None,
        response_language=dialogue.response_language,
        teaching=None,
        trust=None,
    )


@dataclass(frozen=True)
class DiagnosticPolicyRecord:
    """Privacy-safe record — counts/enums/hashes only. NEVER the student's
    message, NEVER document content, NEVER free text of any kind. This is
    the only thing this module's result should ever be logged as."""

    history_source: HistorySource
    policy_hash: str
    needs_clarification: bool
    action_count: int
    target_resolved: bool
    conversation: str
    response_language: str


def to_diagnostic_record(
    policy: ExecutionPolicy, *, history_source: HistorySource,
) -> DiagnosticPolicyRecord:
    return DiagnosticPolicyRecord(
        history_source=history_source,
        policy_hash=policy.policy_hash,
        needs_clarification=policy.needs_clarification,
        action_count=len(policy.actions),
        target_resolved=not any(a.state == "unresolved" for a in policy.actions),
        conversation="",  # intentionally not derived from free text; placeholder for a future enum-only field
        response_language=policy.response_language,
    )


def compile_diagnostic_policy(
    *,
    message: str,
    dialogue: DialogueResolution,
    student_intent: StudentIntent | None,
    user_id: str,
    conversation_id: str | None,
    validate_ownership: Any,
    get_messages: Any,
    has_unverified_context: bool = False,
    authorized_exercise_labels: frozenset[str] = frozenset(),
) -> tuple[ExecutionPolicy, DiagnosticPolicyRecord]:
    """The full diagnostic pipeline: build a real, trusted TurnLedger from
    the durable store (never payload.previousTurns), adapt today's
    deterministic output into the canonical shape, compile through the
    real, already-tested compile_policy, and produce only a privacy-safe
    record. Returns the full ExecutionPolicy too, for a caller that wants
    it for further (still non-authoritative) diagnostic comparison — but
    nothing calls this from any live consumer path (see module docstring
    and test_diagnostic_policy_never_reaches_a_live_consumer).

    ``has_unverified_context`` only affects the ``history_source`` label
    when ``conversation_id`` is falsy — see
    ``build_turn_ledger_from_durable_store``'s docstring. ``conversation_id``
    passed to ``compile_policy`` below stays exactly what the caller gave
    this function either way; this parameter never widens what the
    compiler itself treats as a trusted conversation."""
    history = build_turn_ledger_from_durable_store(
        user_id=user_id, conversation_id=conversation_id,
        validate_ownership=validate_ownership, get_messages=get_messages,
        has_unverified_context=has_unverified_context,
    )
    intent = adapt_deterministic_intent(
        message=message, dialogue=dialogue, student_intent=student_intent,
        authorized_exercise_labels=authorized_exercise_labels,
    )
    policy = compile_policy(intent, turn_ledger=history.ledger, conversation_id=conversation_id)
    return policy, to_diagnostic_record(policy, history_source=history.source)


__all__ = [
    "DIAGNOSTIC_SCHEMA_VERSION",
    "DiagnosticPolicyRecord",
    "DurableHistoryResult",
    "HistorySource",
    "adapt_deterministic_intent",
    "build_turn_ledger_from_durable_store",
    "compile_diagnostic_policy",
    "resolve_target_identity",
    "to_diagnostic_record",
]

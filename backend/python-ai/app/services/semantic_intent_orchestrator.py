"""Semantic Student Intent Layer — authoritative orchestration (Phases A/B).

The one real entry point for SEMANTIC_INTENT_MODE == "enabled" AND
semantic_intent_unified_call_enabled == True. Callers (app/routers/
stream.py) must check both flags themselves before calling anything
here — this module does not re-check mode, the same "thin adapter, not
a second router" pattern diagnostic_policy.py already uses for the
observational path.

Three responsibilities, all built from already-reviewed Milestone 2/3
machinery, nothing reinvented:

1. Escalate to the REAL unified model call (unified_semantic_call.
   perform_unified_semantic_interpretation) only when
   semantic_call_support.needs_semantic_escalation fires — at most ONE
   model call per turn, never a repair-retry on failure. When it
   doesn't fire, or fails, stay fully deterministic (adapt_
   deterministic_intent, reused verbatim from the observational path —
   same zero-model-call guarantee).
2. Build the AUTHORITATIVE TurnLedger from verified, server-owned
   history (never payload.previousTurns, never a non-durable
   conversationId) — same ownership contract as diagnostic_policy.
   build_turn_ledger_from_durable_store, but using the FULL
   get_durable_conversation_messages, not the diagnostics-only bounded
   variant: a lossy fetch is acceptable for observation, not for a real
   permission decision.
3. Compile the final ExecutionPolicy via the existing, already-tested
   policy_compiler.compile_policy — this module adds no new compilation
   logic of its own.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, replace
from typing import Any

from .dialogue_state import DialogueResolution, TurnRelation
from .diagnostic_policy import adapt_deterministic_intent, resolve_target_identity
from .grounding_contract import AccessResolutionReason, ResolvedDocumentAccess
from .policy_compiler import ExecutionPolicy, compile_policy
from .resolved_student_intent import ResolvedStudentIntent, TurnLedger
from .semantic_call_support import needs_semantic_escalation
from .unified_semantic_call import perform_unified_semantic_interpretation

log = logging.getLogger(__name__)

# A complaint that a PRIOR answer was incomplete/missing parts ("you
# didn't answer the whole Aufgabe", "nicht vollständig beantwortet")
# lexically overlaps with grounding_contract._FULL_DOCUMENT_RE's own
# "whole/entire + document-noun" pattern (confirmed by direct testing:
# "the whole Aufgabe" matches BOTH), but means the opposite thing — a
# correction/continuation about specific already-discussed content, not
# a request to process the entire document. Caught deterministically
# (no model call needed) since it's the Milestone 1 report's own
# required document-scope regression case.
_INCOMPLETE_ANSWER_COMPLAINT_RE = re.compile(
    r"\b(?:didn'?t|did\s+not|haven'?t|have\s+not)\s+(?:answer|respond|cover|address)\b|"
    r"\b(?:not\s+answered|unanswered|incomplete|missing|left\s+out)\b|"
    r"\bnicht\s+(?:\w+\s+){0,2}beantwortet\b|\bunvollst(?:ä|ae)ndig\b|\bfehlen?\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class AuthoritativeInterpretation:
    dialogue: DialogueResolution
    resolved_intent: ResolvedStudentIntent
    execution_policy: ExecutionPolicy
    used_unified_call: bool
    unified_call_succeeded: bool


def build_authoritative_turn_ledger(
    *, user_id: str, conversation_id: str | None,
    validate_ownership: Any, get_messages: Any,
) -> TurnLedger | None:
    """Same ownership contract as diagnostic_policy.build_turn_ledger_
    from_durable_store — ``validate_ownership``/``get_messages`` are
    injected (``conversation_store.validate_durable_conversation``/
    ``get_durable_conversation_messages``, the FULL variant) so this
    stays testable without a real database and never gains a hard
    import-time Supabase dependency. Returns None — never falls back to
    any client-supplied substitute — for anything other than a
    verified, owned, durable conversation; compile_policy already
    treats turn_ledger=None safely (an unverifiable cross-turn claim
    degrades to the restrictive tie-break, never an override, never a
    guess)."""
    if not conversation_id:
        return None
    try:
        owned = validate_ownership(user_id=user_id, conversation_id=conversation_id)
    except Exception:  # noqa: BLE001 — a lookup failure must degrade safely, never raise
        return None
    if not owned:
        return None
    try:
        rows = get_messages(user_id=user_id, conversation_id=conversation_id)
    except Exception:  # noqa: BLE001
        return None
    turns = {
        str(row.get("client_message_id") or f"row-{index}"): row
        for index, row in enumerate(rows or [])
    }
    return TurnLedger.build(conversation_id=conversation_id, turns=turns)


def _apply_target_identity_gate(
    intent: ResolvedStudentIntent,
    *,
    original_message: str,
    verified_active_question: str | None,
    authorized_exercise_labels: frozenset[str],
) -> ResolvedStudentIntent:
    """Closes the demonstrated-not-fixed gap: a unified-call action whose
    `target` cannot be grounded in trusted context (the deterministic
    layer's own resolved active_question, a caller-supplied authorized
    label set, or a literal token in the student's own message — see
    ``diagnostic_policy.resolve_target_identity``'s docstring for exactly
    what counts) downgrades to ``state="unresolved"`` here, before
    ``compile_policy`` ever runs. Reuses the SAME grounding check the
    deterministic path (``adapt_deterministic_intent``) already applies
    — this is the one place both paths were missing a shared gate, not a
    second, divergent authorization system.

    ``state="unresolved"`` is never a silent drop or a guess: ``compile_
    policy`` already knows how to turn it into the most restrictive
    per-field fallback for that specific target (prohibited/hint/etc.),
    exactly the same degrade-safely contract every other untrusted claim
    in this pipeline gets."""
    gated_actions = tuple(
        action if resolve_target_identity(
            action.target, original_message=original_message,
            verified_active_question=verified_active_question,
            authorized_exercise_labels=authorized_exercise_labels,
        ) else replace(action, state="unresolved")
        for action in intent.actions
    )
    return replace(intent, actions=gated_actions)


def interpret_turn_authoritatively(
    *,
    question: str,
    dialogue_base: DialogueResolution,
    preflight_turns: list[dict[str, str]],
    user_id: str,
    conversation_id: str | None,
    validate_ownership: Any,
    get_messages: Any,
    resolved_access: Any,
    has_visible_context: bool,
    authorized_exercise_labels: frozenset[str] = frozenset(),
) -> AuthoritativeInterpretation:
    """Resolve one turn authoritatively: at most one model call, a
    verified turn ledger, and a compiled ExecutionPolicy. Never raises —
    any failure anywhere in this pipeline degrades to the fully
    deterministic path, exactly like the legacy two-call sequence it
    replaces for ENABLED + unified-call-enabled requests."""
    from .student_intent import interpret_student_intent  # noqa: WPS433 — avoid import cycle

    escalate = needs_semantic_escalation(
        question, has_unresolved_reference=bool(dialogue_base.referent_type != "unknown"),
    )

    dialogue = dialogue_base
    resolved_intent: ResolvedStudentIntent | None = None
    used_unified_call = False
    unified_call_succeeded = False

    if escalate:
        used_unified_call = True
        unified = perform_unified_semantic_interpretation(
            message=question, dialogue_base=dialogue_base, previous_turns=preflight_turns,
            student_goal_fallback=dialogue_base.resolved_request or question,
            user_id=user_id,
        )
        if unified is not None:
            dialogue = unified.dialogue
            # Milestone 3's named blocking gate, closed here: a unified-
            # call action's claimed `target` is not itself proof of
            # anything (see unified_semantic_call.validate_unified_call_
            # output's own docstring and test_unified_semantic_call.py's
            # test_unresolved_target_identity_claim_is_not_checked_here,
            # which demonstrates — on purpose — that neither that
            # validator nor validate_action_provenance checks it). This
            # is the authority boundary where it must be closed, before
            # compile_policy ever sees the claim.
            resolved_intent = _apply_target_identity_gate(
                unified.intent, original_message=question,
                verified_active_question=dialogue.active_question,
                authorized_exercise_labels=authorized_exercise_labels,
            )
            unified_call_succeeded = True

    if resolved_intent is None:
        # Fully deterministic path — zero model calls. Same deterministic
        # StudentIntent adapter the observational layer already uses,
        # forced to mode="off" so interpret_student_intent's OWN internal
        # escalation (_needs_semantic_path) never ALSO fires a model call
        # here; this function is the sole decision point for whether to
        # escalate.
        deterministic_intent = interpret_student_intent(
            question, dialogue=dialogue, resolved_access=resolved_access,
            has_visible_context=has_visible_context, mode="off",
            previous_turns=preflight_turns, user_id=user_id,
        )
        resolved_intent = adapt_deterministic_intent(
            message=question, dialogue=dialogue, student_intent=deterministic_intent,
            authorized_exercise_labels=authorized_exercise_labels,
        )

    turn_ledger = build_authoritative_turn_ledger(
        user_id=user_id, conversation_id=conversation_id,
        validate_ownership=validate_ownership, get_messages=get_messages,
    )
    execution_policy = compile_policy(
        resolved_intent, turn_ledger=turn_ledger, conversation_id=conversation_id,
    )
    return AuthoritativeInterpretation(
        dialogue=dialogue, resolved_intent=resolved_intent, execution_policy=execution_policy,
        used_unified_call=used_unified_call, unified_call_succeeded=unified_call_succeeded,
    )


def correct_full_document_scope_false_positive(
    *,
    resolved_access: ResolvedDocumentAccess,
    resolution_reason: AccessResolutionReason,
    resolved_intent: ResolvedStudentIntent,
    dialogue: DialogueResolution,
) -> tuple[ResolvedDocumentAccess, AccessResolutionReason]:
    """Phase B required deliverable: ``resolve_document_access()``'s
    lexical "whole/entire + document-noun" regex fires on a correction/
    continuation complaint about a SPECIFIC exercise ("you didn't
    answer the whole Aufgabe, parts a and c are missing") or even on an
    EXPLICIT REJECTION of full-document processing ("Ich möchte keine
    Zusammenfassung des gesamten PDFs") — confirmed by direct testing to
    match both. The regex has no concept of negation or conversational
    relation.

    Never WIDENS access: an ``EXPLICIT_UI_HINT`` (the user's own toggle)
    or any reason other than the lexical natural-language guess is
    returned completely unchanged — this function only ever narrows a
    lexical-only FULL_DOCUMENT guess back to the safe RELEVANCE default
    when independent evidence (deterministic or model-derived) says the
    student does NOT actually want the whole document. The authorization
    layer downstream is unaffected either way — this changes WHICH scope
    is requested, never whether the student is allowed to see it."""
    if resolution_reason is not AccessResolutionReason.NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT:
        return resolved_access, resolution_reason

    looks_like_correction_or_rejection = (
        dialogue.relation in {TurnRelation.CORRECTION, TurnRelation.REJECTION}
        or resolved_intent.conversation in {"correction", "rejection", "follow_up"}
        or any("summarize" in action.prohibited for action in resolved_intent.actions)
        or bool(_INCOMPLETE_ANSWER_COMPLAINT_RE.search(dialogue.original_message))
    )
    if looks_like_correction_or_rejection:
        return ResolvedDocumentAccess.RELEVANCE, AccessResolutionReason.POLICY_OVERRIDE
    return resolved_access, resolution_reason


__all__ = [
    "AuthoritativeInterpretation",
    "build_authoritative_turn_ledger",
    "correct_full_document_scope_false_positive",
    "interpret_turn_authoritatively",
]

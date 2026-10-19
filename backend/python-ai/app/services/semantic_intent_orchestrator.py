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
from .policy_compiler import (
    ExecutionPolicy, FIELD_NAMES, compile_policy, extract_persistable_restrictions,
)
from .resolved_student_intent import (
    Action, Origin, ReleaseConstraints, ResolvedStudentIntent, TurnLedger,
)
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
    # Priority 1 (multi-turn permission persistence): what this turn's
    # caller (stream.py) should write into the turn's existing
    # ai_tutor_requests.request_snapshot so a LATER turn can reconstruct
    # it -- see extract_persistable_restrictions and _merge_persisted_
    # history below. Never a new table/migration, always {} in legacy
    # OFF/SHADOW mode (nothing in that mode ever builds this dataclass).
    compiled_policy_by_target: dict[str, dict[str, Any]]


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


# ---------------------------------------------------------------------------
# Multi-turn permission persistence (Milestone 3 Priority 1). compile_
# policy already merges cross-turn actions correctly (see test_policy_
# compiler.py's test_earlier_turn_prohibition_then_verified_later_turn_
# permission) -- the gap closed here is purely that this orchestrator
# never fed it any historical action to merge against: each turn only
# ever compiled its OWN message's action(s), so an earlier turn's
# prohibition for a target this turn doesn't re-state simply vanished.
#
# The fix reconstructs, from the SAME trusted get_messages rows already
# used to build the turn_ledger, the most recently PERSISTED compiled
# restriction for each target this turn addresses, and injects it as a
# trusted ``Action`` whose ``conversation_turn`` provenance resolves
# against that real ledger -- compile_policy's existing, already-tested
# recency rule (rule 2) then decides, per field, whether this turn's own
# action overrides it. "Persisted" means stream.py writes ``extract_
# persistable_restrictions(execution_policy)`` (policy_compiler.py) into
# the turn's EXISTING ``ai_tutor_requests.request_snapshot`` JSONB column
# -- the same field already used for commentaryEvents/answerProvenance,
# never a new table or migration.
# ---------------------------------------------------------------------------

_UNVERIFIABLE_HISTORY_RELEASE = ReleaseConstraints(
    final_answer="prohibited", official_solution="prohibited",
    explanation_depth="none", form="hint", max_steps=1, max_items=1,
    wait_for_student=True,
)


def _reconstruct_persisted_target_actions(
    current_targets: frozenset[str], turn_ledger: TurnLedger,
) -> tuple[Action, ...]:
    """For each of ``current_targets``, find the most recent (by the
    ledger's own verified chronology, never list/scan order) turn that
    persisted a restriction for that EXACT target string -- never a
    broader/narrower label (that's rule 4's job, for THIS turn's own
    actions, not for history) -- and rebuild it as a trusted ``Action``
    whose provenance names that real, resolvable turn_id. A miss (a
    different target, or genuinely no history for this one) contributes
    nothing for that target, by design: never inherit restrictions
    between unrelated exercises or conversations."""
    found: dict[str, Action] = {}
    remaining = set(current_targets)
    for turn in reversed(turn_ledger.turns):
        if not remaining:
            break
        snapshot = turn.data.get("request_snapshot")
        policy_by_target = snapshot.get("policyByTarget") if isinstance(snapshot, dict) else None
        if not isinstance(policy_by_target, dict):
            continue
        for target in list(remaining):
            raw = policy_by_target.get(target)
            if not isinstance(raw, dict) or not raw:
                continue
            release_kwargs = {field: raw[field] for field in FIELD_NAMES if field in raw}
            try:
                release = ReleaseConstraints(**release_kwargs)
            except TypeError:
                continue  # a corrupt/foreign-shaped snapshot value -- never trust it
            found[target] = Action(
                objective="other", target=target, release=release, state="unspecified",
                provenance=(Origin(kind="conversation_turn", turn_id=turn.turn_id),),
            )
            remaining.discard(target)
    return tuple(found.values())


def _unverifiable_history_sentinel_actions(current_targets: frozenset[str]) -> tuple[Action, ...]:
    """A durable conversation_id was supplied for this turn, but its
    history could not be verified (lookup failure, revoked ownership, a
    deleted conversation -- build_authoritative_turn_ledger collapses
    all of these to ``None``, deliberately, the same as every other
    untrusted claim in this pipeline). Silently proceeding as though this
    were a brand-new, history-free conversation would let a REAL prior
    prohibition revert to permitted purely because of a transient lookup
    failure -- requirement 7's "degrade to the conservative default,
    never to permitted".

    These sentinels are deliberately UNTRUSTED (state="unresolved"):
    compile_policy's existing trust boundary already guarantees an
    untrusted action can never itself set a field or become primary --
    it only forces any field THIS TURN's own trusted action doesn't
    independently address to the most restrictive fallback (the
    "contested_fallback" path) and flags needs_clarification. Anything
    the current message genuinely asks for this turn still goes through
    normally, since a trusted current-turn action always wins that field
    outright -- this never blocks a fresh, self-contained request, only
    an unverifiable cross-turn assumption of "permitted"."""
    return tuple(
        Action(
            objective="other", target=target, release=_UNVERIFIABLE_HISTORY_RELEASE,
            state="unresolved",
        )
        for target in current_targets
    )


def _merge_persisted_history(
    resolved_intent: ResolvedStudentIntent,
    *,
    conversation_id: str | None,
    turn_ledger: TurnLedger | None,
) -> ResolvedStudentIntent:
    """Entry point wired into interpret_turn_authoritatively, between
    building the turn_ledger and calling compile_policy. No-ops (returns
    ``resolved_intent`` unchanged) for a non-durable/stateless turn --
    legacy OFF/SHADOW parity and any caller that never supplies a
    conversation_id are completely unaffected."""
    if not conversation_id:
        return resolved_intent
    # Only targets this turn's OWN interpretation already trusts (never
    # a target the target-identity gate just downgraded to "unresolved"
    # -- that gap is closed separately and must not be reopened by
    # reviving an unrelated target's history for it just because the
    # label string happens to match).
    current_targets = frozenset(
        action.target for action in resolved_intent.actions if action.state != "unresolved"
    )
    if not current_targets:
        return resolved_intent
    historical = (
        _reconstruct_persisted_target_actions(current_targets, turn_ledger)
        if turn_ledger is not None
        else _unverifiable_history_sentinel_actions(current_targets)
    )
    if not historical:
        return resolved_intent
    return replace(resolved_intent, actions=resolved_intent.actions + historical)


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
    resolved_intent = _merge_persisted_history(
        resolved_intent, conversation_id=conversation_id, turn_ledger=turn_ledger,
    )
    execution_policy = compile_policy(
        resolved_intent, turn_ledger=turn_ledger, conversation_id=conversation_id,
    )
    return AuthoritativeInterpretation(
        dialogue=dialogue, resolved_intent=resolved_intent, execution_policy=execution_policy,
        used_unified_call=used_unified_call, unified_call_succeeded=unified_call_succeeded,
        compiled_policy_by_target=extract_persistable_restrictions(execution_policy),
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

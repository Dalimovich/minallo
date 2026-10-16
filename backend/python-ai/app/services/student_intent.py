"""Semantic Student Intent Interpreter — typed contract + deterministic adapter.

PR 1 of the semantic-intent-layer initiative (see
``docs/semantic-intent-layer-map.md`` for the full call-graph trace this is
wired against). This module does NOT replace ``answer_intent.py`` /
``dialogue_state.py`` — it wraps their already-validated outputs into one
typed, testable contract so the execution router and, eventually, prompt
assembly can read a single structured signal instead of each caller
re-deriving its own slice of "what does the student want" from regexes.

Feature-flagged via ``Settings.semantic_intent_mode`` (``off`` / ``shadow`` /
``enabled``, default ``off``). See ``app/config.py``. With the flag off, the
router (``app/routers/stream.py``) never calls ``interpret_student_intent``
at all — not computed-and-discarded, simply not invoked — so there is zero
behavioral or performance change on the hot path.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

from .answer_intent import AcademicIntent, NEGATED_QUIZ_RE, NEGATED_SUMMARY_RE, classify_academic_intent, wants_professor_style
from .dialogue_state import ConversationIntent, DialogueResolution, TurnRelation
from .grounding_contract import ResolvedDocumentAccess

log = logging.getLogger(__name__)

InterpretationSource = Literal["deterministic", "semantic_model", "fallback"]


@dataclass(frozen=True)
class StudentIntent:
    """Structured interpretation of one student turn.

    Invariants (enforced by this module, documented here so a reviewer or a
    future caller can check them without re-reading the implementation):

    1. ``original_message`` is the literal, unmodified student text.
       ``student_goal`` is a paraphrase/resolution of it (reused from
       ``DialogueResolution.resolved_request``) — the two fields must never
       be conflated into one, because prompt assembly needs to be able to
       show/quote the student's own words even when it acts on the resolved
       goal.
    2. ``prohibited_tasks`` is independent of ``primary_task``. A negated
       instruction ("do not summarize") is recorded explicitly rather than
       silently subtracted from consideration — the prompt layer needs both
       "what to do" and "what was explicitly ruled out" as separate signals,
       because a task can be simultaneously absent from ``primary_task`` AND
       still worth an explicit "do not do this" line (e.g. the source
       material itself has a "Zusammenfassung" heading that must not leak
       into the answer even though summarizing was never the primary task).
    3. Evidence boundary / prompt-injection boundary: this module's public
       entry point, ``interpret_student_intent``, has NO parameter that
       accepts retrieved course/document text. It only ever reads the
       student's message, trusted prior conversation turns, and trusted UI
       metadata the router already established (``resolved_access``,
       ``has_visible_context``). Course content is evidence for ANSWERING,
       never an input to INTERPRETING what the student wants — mirrors the
       existing ``routing_chunks`` vs. literal-question separation in
       ``answer_stream.py``.
    4. ``scope`` is populated from the router's already-resolved
       ``ResolvedDocumentAccess`` (itself derived from trusted viewer
       context), never by re-parsing the message for page/document
       references.
    5. Precedence when current message, conversation history, and trusted UI
       metadata disagree: current message's explicit wording outranks
       trusted UI metadata, which outranks older conversation history. A
       student typing "no, the OTHER file" overrides what's merely open in
       the viewer; what's open in the viewer outranks a stale reference from
       three turns ago.
    6. No fabrication: if a reference ("this problem", "that formula") can't
       be resolved against an active exercise label or trusted visible
       context, ``needs_clarification`` is set True rather than guessing a
       page/document/selection that was never actually provided.
    """

    original_message: str
    student_goal: str
    primary_task: AcademicIntent
    prohibited_tasks: tuple[AcademicIntent, ...]
    depth: str
    teaching_style: str
    scope: ResolvedDocumentAccess
    references_resolved: tuple[str, ...]
    references_unresolved: bool
    visual_requirement: bool
    follow_up_type: ConversationIntent | None
    confidence: float
    interpretation_source: InterpretationSource
    needs_clarification: bool


# Cheap code-switch heuristic for PR 2's semantic-path trigger list: Latin
# ASCII letters mixed with Arabic or Latin-Extended/diacritic ranges in the
# same message. Deliberately coarse — PR 2 replaces this with an actual
# model judgment; it only needs to be good enough to decide WHETHER to pay
# for that judgment, not to BE the judgment.
_NON_ASCII_LETTERS_RE = re.compile(r"[À-ɏ؀-ۿ]")
_ASCII_LETTERS_RE = re.compile(r"[a-zA-Z]{3,}")
_VISUAL_RE = re.compile(
    r"\b(diagram|sketch|figure|drawing|draw|graph|plot|chart|"
    r"zeichnung|skizze|diagramm|zeichne|skizziere)\b",
    re.IGNORECASE,
)
_DEICTIC_RE = re.compile(
    r"\b(this|that|it|these|those|the\s+(?:first|second|third|above|below)\s*\w*)\b",
    re.IGNORECASE,
)
_LOW_CONFIDENCE_THRESHOLD = 0.7


def _detect_prohibited_tasks(message: str) -> tuple[AcademicIntent, ...]:
    """Explicit negative constraints, kept separate from positive task
    selection (invariant 2). Reuses the exact patterns that already drive
    the final prompt's "do NOT" lines (``answer_intent.intent_style_
    instruction``) rather than hand-copying them — one source of truth for
    what counts as a prohibition."""
    prohibited: list[AcademicIntent] = []
    if NEGATED_SUMMARY_RE.search(message):
        prohibited.append(AcademicIntent.COURSE_SUMMARY)
    if NEGATED_QUIZ_RE.search(message):
        prohibited.append(AcademicIntent.QUIZ_GENERATION)
    return tuple(prohibited)


def _needs_semantic_path(message: str, dialogue: DialogueResolution) -> bool:
    """Trigger conditions for the (not-yet-implemented) semantic path: see
    the PR 2 plan in docs/semantic-intent-layer-map.md. Returning True here
    never calls a model in this PR — it only decides whether
    ``_semantic_model_stub`` is consulted, and that stub always returns
    None (see its docstring)."""
    if dialogue.confidence < _LOW_CONFIDENCE_THRESHOLD:
        return True
    if dialogue.relation in {TurnRelation.CORRECTION, TurnRelation.REJECTION}:
        return True
    if NEGATED_SUMMARY_RE.search(message) or NEGATED_QUIZ_RE.search(message):
        return True
    if _ASCII_LETTERS_RE.search(message) and _NON_ASCII_LETTERS_RE.search(message):
        return True
    return False


def _semantic_model_stub(*, message: str, dialogue: DialogueResolution) -> StudentIntent | None:
    """PR 2 seam. Deliberately a no-op in PR 1: no network call, no paid
    model invocation, per this initiative's explicit scope. Returning None
    always routes the caller to the deterministic fallback with
    ``interpretation_source="fallback"``.

    When PR 2 implements this, it should mirror
    ``dialogue_state.resolve_dialogue_semantically``'s shape exactly: a
    structured-output call on ``get_settings().openai_generate_model`` at
    ``reasoning_effort="low"``, bounded output tokens, a single retry,
    ``INTERACTIVE_CLASSIFIER_TIMEOUT``, and a fail-closed ``except
    Exception`` that returns None instead of raising — see the PR 2 plan
    section of docs/semantic-intent-layer-map.md for the full checklist
    (schema, cost control, offline eval harness).
    """
    del message, dialogue  # unused in this PR; kept in the signature for PR 2
    return None


def interpret_student_intent(
    message: str,
    *,
    dialogue: DialogueResolution,
    resolved_access: ResolvedDocumentAccess,
    has_visible_context: bool = False,
    mode: str = "off",
) -> StudentIntent:
    """Deterministic adapter over the already-validated ``answer_intent`` /
    ``dialogue_state`` outputs (invariant 3: no document/chunk text is
    accepted here — only the student's message and signals the router
    already trusts).

    ``dialogue`` is the caller's already-computed ``DialogueResolution``
    (from ``resolve_dialogue`` / ``resolve_dialogue_semantically``) — this
    function does not re-run dialogue resolution; it is a thin adapter, not
    a second router. ``resolved_access`` is the router's own
    ``ResolvedDocumentAccess`` (invariant 4).

    ``mode`` mirrors ``Settings.semantic_intent_mode`` ("off" / "shadow" /
    "enabled"). "off" never reaches the semantic-path check at all when
    called the way ``app/routers/stream.py`` calls it (guarded by the flag
    before this function is invoked) — the parameter exists so this
    function's own unit tests can exercise all three states directly.
    """
    started = time.perf_counter()
    text = message or ""
    student_goal = dialogue.resolved_request or text
    primary_task = classify_academic_intent(student_goal)
    prohibited_tasks = _detect_prohibited_tasks(text)

    active_ref = dialogue.active_question
    references_resolved = (active_ref,) if active_ref else ()
    # A reference is "unresolved" (invariant 6: never fabricate) only when
    # the message is deictic AND nothing — not an active exercise label, not
    # trusted visible-page/viewer context — actually anchors it.
    references_unresolved = bool(
        _DEICTIC_RE.search(text)
        and not references_resolved
        and not has_visible_context
    )
    needs_clarification = references_unresolved

    follow_up_type = (
        dialogue.conversation_intent
        if dialogue.conversation_intent is not ConversationIntent.NEW_QUESTION
        else None
    )

    source: InterpretationSource = "deterministic"
    confidence = dialogue.confidence
    if mode != "off" and _needs_semantic_path(text, dialogue):
        # Fail-closed (mirrors dialogue_state.resolve_dialogue_semantically):
        # a timeout, malformed response, or any other exception from the
        # (currently stubbed) semantic path must never propagate up to the
        # request handler — it degrades to the deterministic result with
        # interpretation_source="fallback" instead.
        try:
            semantic_result = _semantic_model_stub(message=text, dialogue=dialogue)
        except Exception as exc:  # noqa: BLE001 — deliberate fail-closed boundary
            log.info("semantic_intent_stub_exception exception=%s", type(exc).__name__)
            semantic_result = None
        if semantic_result is not None:
            # PR 2: a real semantic result would be returned here, already
            # carrying its own confidence/source. Unreachable in PR 1 since
            # _semantic_model_stub always returns None.
            latency_ms = (time.perf_counter() - started) * 1000
            _log_shadow(mode, semantic_result, latency_ms)
            return semantic_result
        source = "fallback"

    intent = StudentIntent(
        original_message=text,
        student_goal=student_goal,
        primary_task=primary_task,
        prohibited_tasks=prohibited_tasks,
        depth=dialogue.requested_depth,
        teaching_style="professor_style" if wants_professor_style(text) else "default",
        scope=resolved_access,
        references_resolved=references_resolved,
        references_unresolved=references_unresolved,
        visual_requirement=bool(_VISUAL_RE.search(text)),
        follow_up_type=follow_up_type,
        confidence=confidence,
        interpretation_source=source,
        needs_clarification=needs_clarification,
    )
    latency_ms = (time.perf_counter() - started) * 1000
    if mode != "off":
        _log_shadow(mode, intent, latency_ms)
    return intent


def _log_shadow(mode: str, intent: StudentIntent, latency_ms: float) -> None:
    """Privacy-conscious diagnostics: counts/enums/latency only — never the
    message or document text. Fired for shadow AND enabled modes (never for
    "off", which never calls this module at all)."""
    log.info(
        "semantic_intent mode=%s source=%s primary_task=%s prohibited_count=%d "
        "needs_clarification=%s confidence=%.2f latency_ms=%.1f",
        mode, intent.interpretation_source, intent.primary_task.value,
        len(intent.prohibited_tasks), intent.needs_clarification, intent.confidence,
        latency_ms,
    )


def execution_signal(intent: Any | None) -> tuple[str, ...]:
    """What ``execution_router.resolve_execution_plan`` adds to its
    ``signals`` tuple when a ``StudentIntent`` is supplied. Kept here (not
    duplicated in ``execution_router.py``) so the one marker string has a
    single definition; ``execution_router.py`` imports this function rather
    than hand-copying the literal."""
    return ("semantic_intent_available",) if intent is not None else ()


def intent_for_router(mode: str, intent: StudentIntent | None) -> StudentIntent | None:
    """What ``app/routers/stream.py`` should forward to
    ``resolve_execution_plan`` once ``interpret_student_intent`` has run.

    "shadow" computes the intent purely for the diagnostics logged inside
    ``interpret_student_intent`` itself — it must never reach the router,
    because the router's ``signals`` tuple is serialized into the SSE
    ``executionPlan`` payload (``ExecutionPlan.to_api()``), which would make
    "shadow" affect the response on the wire despite the explicit contract
    (``Settings.semantic_intent_mode`` docstring) that shadow never does.
    Only "enabled" attaches it as an additional, non-authoritative signal.
    """
    return intent if mode == "enabled" else None


__all__ = [
    "InterpretationSource", "StudentIntent", "execution_signal",
    "intent_for_router", "interpret_student_intent",
]

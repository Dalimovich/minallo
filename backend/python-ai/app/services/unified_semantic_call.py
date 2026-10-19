"""Milestone 2 (Decision 1) — a ONE-CALL adapter PROPOSAL replacing
today's two sequential classification calls (``dialogue_state.
resolve_dialogue_semantically`` + ``student_intent._semantic_model_call``)
with a single structured-output call, per the budget: at most ONE semantic
interpretation/classification call per incoming student turn, TOTAL,
across the dialogue and intent classifiers combined.

NOT wired into any router or real call site. Isolated, additive, mocked
foundation work — same pattern as the rest of Milestone 2. Nothing here
makes a model call; every test mocks the client.

Why ``asyncio.gather`` (``concurrent_classification.py``) does NOT satisfy
this budget and is NOT the chosen direction: it still issues two calls
(cost unchanged), and its own test suite already demonstrates a real
accuracy cost from running call #2 against the deterministic ``base``
dialogue instead of call #1's resolved output (see
``test_concurrent_classification.py::
test_concurrent_path_produces_a_measurably_less_resolved_student_goal``).
That module is kept, as-is, documented as superseded by this proposal for
the budget decision — not deleted, not wired in either.

---

Design, against the five invariants the decision asked for:

(a) Trusted deterministic context resolution still feeds the call.
    ``build_unified_call_frame`` takes the SAME deterministic inputs
    today's two calls already use before either model call runs: the
    lexically-inferred active task family, the bounded recent-turns
    window, and the current message. No retrieved course/document text —
    same evidence boundary as ``student_intent.py``'s invariant 3.

(b) Correct follow-up/reference resolution is preserved by construction,
    not degraded: this is the entire point of doing it in ONE call rather
    than ``asyncio.gather``'s two concurrent ones. The model sees the
    current message AND the recent turns TOGETHER in one prompt, so there
    is no "stale deterministic base" problem at all — compare
    ``test_unified_call_matches_sequential_two_call_resolution_for_goahead``
    below with ``concurrent_classification.py``'s demonstrated regression
    for the exact same fixture.

(c) Independent authorization is unaffected: this module (like
    ``semantic_call_support.py`` before it) produces, at most, a
    ``ResolvedStudentIntent`` candidate. It never grants document access,
    never bypasses ``policy_compiler.compile_policy``'s platform-policy
    clamp, and every action it proposes still goes through
    ``validate_action_provenance``/``compile_policy`` exactly like any
    other candidate would. Nothing about merging the two calls changes
    what's authorized — only what produces the CLAIM that compile_policy
    then checks.

(d) Failure isolation — the real, NOT-papered-over trade-off: today, call
    #1 and call #2 each fail closed INDEPENDENTLY. A call #1 timeout still
    leaves call #2's own (independently-fired) classification intact, and
    vice versa. With one merged call, a single timeout/malformed-JSON
    failure degrades BOTH the dialogue-relation resolution AND the intent
    extraction AT ONCE — there is no longer a scenario where "the
    reference resolution succeeded but the prohibition extraction failed"
    or vice versa; it's all-or-nothing. ``safe_fallback`` below reuses the
    existing restrictive-fallback machinery (every action's state forced
    to ``"unresolved"``, letting ``policy_compiler``'s per-field
    restrictive defaults take over), but the BLAST RADIUS of one failure
    is strictly larger than today's two-independent-calls behavior. This
    is a genuine latency-vs-blast-radius trade-off, not a free lunch.

(e) Safe fallback reuses existing machinery: ``safe_fallback`` produces a
    ``ResolvedStudentIntent`` whose actions are all ``state="unresolved"``
    — exactly what ``policy_compiler.compile_policy`` already knows how to
    degrade safely (per-field restrictive fallback, never one global
    "safe mode" — the same invariant Milestone 2's hardening pass already
    proved). No new fallback logic was invented for this module.

Qualitative risk NOT testable with mocks (reported, not hidden): the
combined JSON schema asked of one call is objectively larger than either
of today's two schemas (dialogue-relation fields AND multi-action
extraction fields in one response). Structured-output tasks generally see
more classification errors as schema size/complexity grows. Nothing in
this mocked test suite can measure that — it would require the real,
budget-gated held-out evaluation the Milestone 1 report already flags
(§9) as a separate, explicitly-approved spend. Flagging it here so it
isn't silently assumed away.
"""

from __future__ import annotations

from typing import Any, Mapping, get_args

from .resolved_student_intent import (
    Action,
    ConversationShape,
    ResolvedStudentIntent,
)
from .semantic_call_support import validate_semantic_action

SCHEMA_VERSION = "1.0.0"
_CONVERSATION_VALUES = set(get_args(ConversationShape))
_MAX_ACTIONS = 8  # generous bound on one turn's extracted actions — cost/sanity cap, not a product limit


def build_unified_call_frame(
    *, message: str, previous_turns: list[dict[str, str]], active_task_hint: str | None = None,
) -> dict[str, Any]:
    """The ONE prompt's input frame. Mirrors today's two calls' own frames
    (``dialogue_state.resolve_dialogue_semantically`` / ``student_intent.
    _semantic_model_call``) — current message, a bounded recent-turns
    window, and a deterministic hint about the active task family — never
    retrieved course/document text (invariant (a)/evidence boundary)."""
    return {
        "currentMessage": message,
        "recentTurns": (previous_turns or [])[-10:],
        "activeTaskHint": active_task_hint,
    }


def validate_unified_call_output(
    raw: Mapping[str, Any],
    *,
    original_message: str,
    student_goal_fallback: str,
    base_actions: Mapping[str, Action] | None = None,
    platform_forbidden: Mapping[str, Any] | None = None,
    confidence_floor: float = 0.65,
) -> ResolvedStudentIntent | None:
    """Validate one unified-call payload into a ``ResolvedStudentIntent``.
    Fail-closed: ``None`` on ANY schema violation or sub-floor confidence
    — never a propagated exception, never a guess.

    ``base_actions`` (``target -> Action``), when supplied, is the
    caller's own already-trusted per-target baseline (e.g. from a prior
    turn) — each proposed action is validated against the matching
    base_action via ``semantic_call_support.validate_semantic_action``'s
    existing never-loosen-a-trusted-value consistency check. This module
    does not reimplement that check; it reuses it per action, exactly as
    a two-call design's intent classifier would.
    """
    try:
        if not isinstance(raw, Mapping):
            return None
        conversation = raw.get("conversation")
        if conversation not in _CONVERSATION_VALUES:
            return None
        student_goal = raw.get("studentGoal")
        if student_goal is not None and not isinstance(student_goal, str):
            return None
        response_language = raw.get("responseLanguage")
        if response_language is not None and not isinstance(response_language, str):
            return None
        confidence = raw.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            return None
        if not 0.0 <= confidence <= 1.0:
            return None
        if confidence < confidence_floor:
            return None

        raw_actions = raw.get("actions")
        if not isinstance(raw_actions, list) or not raw_actions or len(raw_actions) > _MAX_ACTIONS:
            return None

        actions: list[Action] = []
        for raw_action in raw_actions:
            target = raw_action.get("target") if isinstance(raw_action, Mapping) else None
            base_action = (base_actions or {}).get(target) if isinstance(target, str) else None
            validated = validate_semantic_action(
                raw_action, base_action=base_action, platform_forbidden=platform_forbidden,
                confidence_floor=confidence_floor,
            )
            if validated is None:
                return None  # one malformed/inconsistent action fails the whole call — no partial trust
            # Provenance note (code review, Decision-2-era): an empty
            # `provenance` tuple means "left alone" to
            # resolved_student_intent.validate_action_provenance — correct
            # for a deterministic parse, wrong for an UNCHECKED claim that
            # reaches outside the current message. A model-sourced
            # changed_by_turn claim specifically is already impossible to
            # smuggle through here: semantic_call_support._validated_release
            # rejects "changed_by_turn" as an unknown field for ANY
            # model-sourced release payload (existing hardening-pass
            # decision, confirmed still in effect by
            # test_model_cannot_set_changed_by_turn_directly in
            # test_semantic_call_support.py) — so that specific vector is
            # already closed, not newly fixed here. What is NOT checked at
            # all, by this function or validate_semantic_action: whether
            # `target` corresponds to anything real in this conversation
            # (a model can freely claim target="Aufgabe 7" even if no such
            # exercise was ever mentioned), and whether `conversation`
            # (e.g. "follow_up"/"correction") actually corresponds to a
            # real prior turn — neither this validator nor
            # validate_action_provenance receives the trusted viewer-
            # context/ledger needed to check either. See
            # test_unresolved_target_identity_claim_is_not_checked_here
            # (demonstrates, does not fix) and the Milestone 3 plan's
            # provenance "blocking gate" for the required follow-up.
            actions.append(validated)
    except Exception:  # noqa: BLE001 — deliberate fail-closed boundary, same house style as semantic_call_support.py
        return None

    return ResolvedStudentIntent(
        schema_version=SCHEMA_VERSION,
        original_message=original_message,
        student_goal=(student_goal or student_goal_fallback),
        actions=tuple(actions),
        conversation=conversation,
        references=None,
        response_language=(response_language or ""),
        teaching=None,
        trust=None,
    )


def safe_fallback(
    *, original_message: str, student_goal: str, trusted_actions: tuple[Action, ...] = (),
    response_language: str = "",
) -> ResolvedStudentIntent:
    """What a single unified-call failure (timeout, malformed JSON,
    sub-floor confidence) degrades to.

    Corrected behavior (code review): ``trusted_actions`` — whatever was
    ALREADY established through a completely different, unrelated path
    before this call was even attempted (e.g. the deterministic layer's
    own best-effort actions, or a previously ledger-verified policy
    carried over from an earlier turn) — is preserved VERBATIM, not
    force-downgraded. A single failed call contributed nothing new; it
    must not also erase instructions that were never its to lose. The
    previous version of this function forced every passed-in action to
    ``state="unresolved"`` unconditionally, which discarded reliable,
    already-verified fields for no reason connected to the actual
    failure.

    Only when there is NO trusted baseline at all (a brand-new turn,
    nothing yet established, and now also no working call) does this
    synthesize one explicitly unresolved placeholder action —
    ``policy_compiler.compile_policy`` already knows how to turn
    ``state="unresolved"`` into a per-field restrictive fallback (not one
    global "safe mode"); this function does not invent new fallback
    logic for that case either. See the module docstring's invariant (d)
    for why a merged call's blast radius is still larger than today's two
    independent fallbacks on an actual failure — this fix narrows that
    gap but does not close it (a failure still loses whatever the ONE
    call would have newly contributed; it just stops also losing what
    was already known)."""
    actions = trusted_actions or (
        Action(objective="other", target="unresolved", state="unresolved"),
    )
    return ResolvedStudentIntent(
        schema_version=SCHEMA_VERSION,
        original_message=original_message,
        student_goal=student_goal,
        actions=actions,
        conversation="new",
        references=None,
        response_language=response_language,
        teaching=None,
        trust=None,
    )


__all__ = [
    "SCHEMA_VERSION",
    "build_unified_call_frame",
    "safe_fallback",
    "validate_unified_call_output",
]

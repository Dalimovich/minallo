"""Semantic Student Intent Layer Phase D (completion) — real SSE-level
regression tests proving the release gate actually governs what reaches
the student over /ask-stream, not just scan_generated_answer_for_
prohibited_release in isolation.

Phase D landed with the validator built (app/services/answer_release_
validator.py) but never called from app/routers/stream.py's generation
cascade — a restricted answer was buffered, then flushed verbatim with
zero content check. This file proves the completed wiring: for a
compiled ExecutionPolicy that prohibits final_answer for the active
target, no matter what the mocked model drafts (plain prose, a table
cell, LaTeX, a "let's check our work" framing, or even a clean-looking
draft a regex would never catch), the SSE stream delivered to the
student never contains it, the cache is never asked to persist it, and
the student instead receives the deterministic withheld-answer message.

Route-level harness copied from test_stream_route_multiturn.py's lighter,
single-turn scaffold (same mock set, same direct ``ask_stream_endpoint``
call + ``response.body_iterator`` drain) — reused, not reinvented. The
real ``interpret_turn_authoritatively`` entry point is replaced with a
fake returning a fixed, hand-built ``ExecutionPolicy`` so these tests
exercise the real stream.py wiring without a real OpenAI call for the
semantic interpretation step either (SEMANTIC_INTENT_* flags are set to
"enabled"/true only inside this test's own monkeypatched env — never
touching any real/production config, per this task's restrictions)."""

from __future__ import annotations

import asyncio
import json

import pytest

QUESTION = "Solve Aufgabe 5b."
USER_ID = "00000000-0000-4000-8000-00000000a001"
DOCUMENT_ID = "00000000-0000-4000-8000-00000000a002"


def _restrictive_policy():
    from app.services.policy_compiler import ExecutionPolicy
    from app.services.resolved_student_intent import Action, ReleaseConstraints

    return ExecutionPolicy(
        actions=(
            Action(
                objective="hint", target="5b", state="requested",
                release=ReleaseConstraints(form="hint", final_answer="prohibited"),
            ),
        ),
        evidence_requirements=(), needs_clarification=False, clarification_question=None,
        response_language="en", response_language_reason="default", platform_policy_applied=(),
        policy_version="1.0.0", compiler_version="1.0.0", policy_hash="restricted-5b",
    )


def _mixed_5a_permitted_5b_prohibited_policy():
    """Priority 2's central case, as a real compiled policy: 'give the
    full answer for 5a, but only a hint for 5b'."""
    from app.services.policy_compiler import ExecutionPolicy
    from app.services.resolved_student_intent import Action, ReleaseConstraints

    return ExecutionPolicy(
        actions=(
            Action(objective="solve", target="5a", state="requested",
                   release=ReleaseConstraints(form="worked_solution", final_answer="permitted")),
            Action(objective="hint", target="5b", state="requested",
                   release=ReleaseConstraints(form="hint", final_answer="prohibited")),
        ),
        evidence_requirements=(), needs_clarification=False, clarification_question=None,
        response_language="en", response_language_reason="default", platform_policy_applied=(),
        policy_version="1.0.0", compiler_version="1.0.0", policy_hash="mixed-5a-5b",
    )


def _real_compiled_explain_policy_ab02_ab03():
    """Not hand-built like the policies above -- this goes through the
    REAL compile_policy (same call semantic_intent_orchestrator.
    interpret_turn_authoritatively makes), for an objective="explain"
    action with release left completely unspecified: the exact shape
    the unified semantic call produced for both AB-02 ("Aufgabe 1 raff
    ich grad nicht so richtig") and AB-03 ("this cutting speed thing
    makes no sense to me can u explain"). Proves the policy_compiler.py
    explain-objective fallback's output actually reaches the SSE gate,
    not just that compile_policy returns the right dataclass in
    isolation (test_policy_compiler.py already covers that)."""
    from app.services.policy_compiler import compile_policy
    from app.services.resolved_student_intent import (
        Action, ReleaseConstraints, ResolvedStudentIntent, SCHEMA_VERSION,
    )

    intent = ResolvedStudentIntent(
        schema_version=SCHEMA_VERSION, original_message=QUESTION, student_goal=QUESTION,
        actions=(
            Action(objective="explain", target="5b", state="requested", release=ReleaseConstraints()),
        ),
        conversation="new", references=None, response_language="en", teaching=None, trust=None,
    )
    return compile_policy(intent)


def _permissive_policy():
    from app.services.policy_compiler import ExecutionPolicy
    from app.services.resolved_student_intent import Action, ReleaseConstraints

    return ExecutionPolicy(
        actions=(
            Action(
                objective="solve", target="5b", state="requested",
                release=ReleaseConstraints(form="worked_solution", final_answer="permitted"),
            ),
        ),
        evidence_requirements=(), needs_clarification=False, clarification_question=None,
        response_language="en", response_language_reason="default", platform_policy_applied=(),
        policy_version="1.0.0", compiler_version="1.0.0", policy_hash="permitted-5b",
    )


def _setup(monkeypatch, *, policy, draft_text: str, conversation_id: str):
    """Shared route-level scaffold — same mock set as
    test_stream_route_multiturn.py's single-turn tests, plus forcing the
    real interpret_turn_authoritatively entry point to return our
    hand-built policy instead of making a real model call."""
    from app.config import get_settings
    from app.routers import stream
    from app.services import cache, mastery, retrieval, semantic_intent_orchestrator, tutor_state_store
    from app.services.tutor_state import TutorState

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "enabled")
    monkeypatch.setenv("SEMANTIC_INTENT_UNIFIED_CALL_ENABLED", "true")
    monkeypatch.setenv("SEMANTIC_INTENT_POLICY_ENFORCEMENT_ENABLED", "true")
    get_settings.cache_clear()

    latest_generation = 0

    def claim(_uid, _conversation, _course, generation):
        nonlocal latest_generation
        if generation < latest_generation:
            return False
        latest_generation = generation
        return True

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(tutor_state_store, "claim_generation", claim)
    monkeypatch.setattr(
        tutor_state_store, "load_tutor_state",
        lambda *_a, **_k: TutorState(conversation_id=conversation_id, user_id=USER_ID),
    )
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", lambda *_a, **_k: None)
    monkeypatch.setattr(
        tutor_state_store, "current_persisted_generation", lambda *_a, **_k: latest_generation,
    )
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            DOCUMENT_ID: {
                "id": DOCUMENT_ID,
                "user_id": USER_ID,
                "course_id": "course-1",
                "file_name": "exam.pdf",
                "storage_path": "synthetic/exam.pdf",
                "document_hash": "rev-1",
                "processing_status": "ready",
                "page_count": 2,
                "chunk_count": 5,
            }
        },
    )
    monkeypatch.setattr(stream, "fetch_workspace_snapshot", lambda *_: None)
    # Avoid a real (DNS-failing in this offline test env) Supabase call —
    # same no-profile no-op every other mock in this fixture already uses.
    monkeypatch.setattr(stream, "get_german_learner_profile", lambda *_a, **_k: None)
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_: [])
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)

    save_calls: list[dict] = []
    monkeypatch.setattr(cache, "save_answer", lambda **kwargs: save_calls.append(kwargs))

    chunk = retrieval.RetrievedChunk(
        chunk_id="c1", document_id=DOCUMENT_ID, page_start=1, page_end=1,
        text="Aufgabe 5b. m = 10 kg.", score=1.0, similarity=1.0,
        chunk_type="exercise", section_title="Aufgabe 5",
    )
    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", lambda **_: [chunk])
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **_: [chunk])
    # stream.py module-level-imports these names (``from ..services.
    # retrieval import retrieve_exercise_block``), so it holds its OWN
    # binding — patching the retrieval module's attribute above does not
    # reach stream.py's call site when the question actually matches an
    # exercise reference (unlike the lighter sibling test in
    # test_stream_route_multiturn.py, whose question never matches one,
    # so the real function's own early-return made the module-level
    # mock's ineffectiveness invisible there).
    monkeypatch.setattr(stream, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **_: type("R", (), {"chunks": [chunk], "evidence": [], "to_dict": lambda self: {}})(),
    )
    monkeypatch.setattr(
        stream, "research_unresolved_items",
        lambda *_a, **_k: type("FR", (), {"sources": [], "prompt_overlay": lambda self: ""})(),
    )
    monkeypatch.setattr(stream, "fetch_account_snapshot", lambda *_a, **_k: None)

    def fake_stream_answer(**_kwargs):
        done = {
            "done": True, "retrievalMode": "strong", "answerMode": "math", "sources": [],
            "verification": {
                "status": "verified",
                "details": {
                    "criticalNumericalMismatch": False,
                    "numberMisses": [],
                    "fabricatedFilenames": [],
                    "invalidSourceIndices": [],
                    "fakeSolutionPhrases": [],
                },
            },
        }
        yield 'data: {"meta": true}\n\n'.encode()
        yield f'data: {json.dumps({"t": draft_text})}\n\n'.encode()
        yield f"data: {json.dumps(done)}\n\n".encode()

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    def fake_interpret_turn_authoritatively(*, dialogue_base, **_kwargs):
        from app.services.resolved_student_intent import Action, ReleaseConstraints, ResolvedStudentIntent
        from app.services.semantic_intent_orchestrator import AuthoritativeInterpretation

        intent = ResolvedStudentIntent(
            schema_version="1.0.0", original_message=QUESTION, student_goal=QUESTION,
            actions=(Action(objective="hint", target="5b", state="requested",
                             release=ReleaseConstraints()),),
            conversation="new", references=None, response_language="en",
            teaching=None, trust=None,
        )
        return AuthoritativeInterpretation(
            dialogue=dialogue_base, resolved_intent=intent, execution_policy=policy,
            used_unified_call=True, unified_call_succeeded=True,
            compiled_policy_by_target={},
        )

    monkeypatch.setattr(
        semantic_intent_orchestrator, "interpret_turn_authoritatively",
        fake_interpret_turn_authoritatively,
    )

    return stream, save_calls


async def _run(stream, *, conversation_id: str, **extra_payload):
    question = extra_payload.pop("question", QUESTION)
    payload = stream.AskStreamRequest(
        courseId="course-1",
        activeDocumentId=DOCUMENT_ID,
        question=question,
        visiblePage=1,
        sourceMode="course_files",
        openFileContext="[CURRENTLY VISIBLE PDF PAGE]\nFile: exam.pdf\nPage: 1 of 2\n\n",
        conversationId=conversation_id,
        conversationGeneration=1,
        **extra_payload,
    )
    response = await stream.ask_stream_endpoint(payload, {"id": USER_ID})
    return b"".join([event async for event in response.body_iterator])


@pytest.mark.parametrize("draft_text,leak_needle", [
    ("Let's work through the method. The final answer is 42 N, as derived above.", b"42 N, as derived above"),
    ("Using the moment balance, we get F = m * a. Therefore F = 42 N.", b"Therefore F = 42 N"),
    (r"After simplifying, we get \boxed{42\,\text{N}}.", b"boxed"),
    ("Here is the summary:\n\n| Quantity | Value |\n|---|---|\n| Final Answer | 42 N |\n", b"Final Answer | 42 N"),
])
def test_restricted_final_answer_never_reaches_the_sse_stream(monkeypatch, draft_text, leak_needle):
    conversation_id = f"release-gate-leak-{abs(hash(draft_text))}"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert leak_needle not in body, body
    assert b"withholding" in body.lower() or b"zur\\u00fcck" in body.lower() or b"zur" in body.lower()
    assert b'"done": true' in body
    # The gate marks the done event with a recovery code specifically so
    # the existing (pre-Phase-D) save-gate in stream.py — which already
    # refuses to persist any answer carrying a `recovery` field — treats
    # this turn as unpersistable, the same mechanism every other safety
    # branch in this cascade already relies on.
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls, "a withheld/restricted answer must never be persisted to the cache"


def test_explain_objective_unspecified_release_is_withheld_over_sse_ab02_ab03(monkeypatch):
    """End-to-end for the AB-02/AB-03 fix: a REAL compile_policy output
    (not a hand-built ExecutionPolicy) for an unspecified-release
    "explain" action still gets its final_answer withheld over the
    actual SSE route, the same way the already-proven "hint" case does.
    Closes the gap between test_policy_compiler.py (proves compile_
    policy's return value) and this file (otherwise only ever exercises
    hand-built policies) -- this is the one place that proves the fix
    reaches the student-visible stream, not just the dataclass."""
    draft_text = "For Aufgabe 1: the final answer is R_A = 75 N, R_B = 25 N."
    conversation_id = "release-gate-explain-ab02-ab03"
    stream, save_calls = _setup(
        monkeypatch, policy=_real_compiled_explain_policy_ab02_ab03(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"75 N" not in body and b"25 N" not in body, body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls, "a withheld/restricted answer must never be persisted to the cache"


def test_mixed_permission_unmatched_leak_shape_still_withheld_whole_over_sse(monkeypatch):
    """Non-regression for the MULTI-target case specifically: a clean-
    looking draft with no recognizable leak SHAPE at all (no "final
    answer is", no boxed{}, no table, no "therefore X ="...) must still
    be withheld when two or more distinct targets are in play —
    enforce_release_policy_per_target still delegates unconditionally to
    enforce_release_policy for multi-target policies, untouched by the
    hint-suppression fix. This is the multi-target half of the case that
    used to be proven with a single-target policy before that fix; see
    test_single_target_disguised_leak_with_no_known_shape_is_a_known_gap
    below for the (intentionally different) single-target behavior."""
    draft_text = "[[TARGET: 5a]]\nThe beam carries 42 N at the support.\n[[TARGET: 5b]]\nThink about the forces.\n[[END]]\n"
    conversation_id = "release-gate-mixed-unmatched-shape"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"The beam carries 42 N at the support" not in body
    assert b'"releaseWithheld": true' in body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls


def test_single_target_disguised_leak_with_no_known_shape_is_a_known_gap(monkeypatch):
    """Honest documentation of the residual risk the hint-suppression fix
    explicitly does NOT close (see answer_release_validator.py's module
    docstring): for a genuinely single-target policy, release is now
    conditioned on the leak-pattern scan, not unconditional. A disguised
    final-answer statement with no recognizable leak SHAPE at all ("The
    beam carries 42 N at the support." — stating the result as a plain
    fact, no "final answer is", no "therefore X =", no boxed{}, no
    table) is NOT caught by this (or any realistic finite) pattern list,
    so it IS released here, unlike before this fix (when single-target
    restricted policies withheld unconditionally regardless of scan
    result). This test exists so that gap is proven and visible, not
    silently assumed away — it is not a bug in the fix, it is the fix's
    documented, accepted residual risk."""
    draft_text = "The beam carries 42 N at the support."
    conversation_id = "release-gate-single-target-residual-gap"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"The beam carries 42 N at the support" in body
    assert b'"releaseWithheld": false' in body
    assert b'"code": "answer_release_restricted"' not in body
    del save_calls


def test_permitted_final_answer_still_streams_normally(monkeypatch):
    """Non-regression: a policy that PERMITS the final answer for the
    active target must behave exactly as before — the gate must not
    withhold content it was never asked to restrict."""
    draft_text = "The final answer is 42 N, as derived above."
    conversation_id = "release-gate-permitted"
    stream, save_calls = _setup(
        monkeypatch, policy=_permissive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"42 N, as derived above" in body
    assert b'"done": true' in body
    assert b"releaseWithheld" not in body
    assert b'"code": "answer_release_restricted"' not in body
    # This question's tutor_mode/open-context combination falls outside
    # this route's unrelated `cacheable` gate (unchanged by this fix —
    # see stream.py's `cacheable = (...)` definition), so save_calls
    # being empty here proves nothing about release-gate correctness
    # either way; test_restricted_final_answer_never_reaches_the_sse_
    # stream above is what actually proves a withheld answer never
    # reaches save_answer. del to make that explicit rather than silently
    # unused.
    del save_calls


def test_visual_denial_repair_cannot_bypass_the_release_gate(monkeypatch):
    """Repair-bypass scenario (spec §5 #6): a draft that falsely claims it
    can't see an attached image would normally trigger stream.py's
    false_visual_denial repair branch, which calls a FRESH, unchecked
    model generation (repair_false_visual_denial_sync) and yields its
    result directly — a path the centralized release gate must preempt
    entirely for a restricted target, not merely race against. Does NOT
    mock repair_false_visual_denial_sync/generate_grounded_repair_sync at
    all: if the gate's ordering regresses and that branch runs again, this
    test would hit a real (mocked-away-at-the-httpx-level, so it fails
    loud rather than hanging) network call instead of silently passing.

    Uses the MIXED-permission (multi-target) policy specifically, so this
    keeps proving the untouched, unconditional-withhold path (the
    hint-suppression fix only changes the single-target path — see
    test_single_target_false_visual_denial_is_released_not_withheld
    below for that intentionally different, single-target case)."""
    draft_text = "I'm sorry, I cannot see the image you're referring to."
    conversation_id = "release-gate-visual-denial"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(
            stream, conversation_id=conversation_id,
            openFileImages=[stream.OpenFileImagePayload(mediaType="image/jpeg", data="QQ==")],
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"cannot see the image" not in body
    assert b"withholding" in body.lower() or b"zur" in body.lower()
    assert b'"code": "answer_release_restricted"' in body
    assert b'"done": true' in body
    assert not save_calls


def test_single_target_false_visual_denial_is_released_not_withheld(monkeypatch):
    """Flagged, intentional consequence of the hint-suppression fix (see
    answer_release_validator.py's module docstring): for a SINGLE-target
    restricted policy, this draft contains no leak-pattern match at all
    — it is a false claim about not seeing an attached image, not a
    revealed final answer/official solution — so the new scan-
    conditioned single-target gate releases it as-is instead of
    replacing it with the generic withheld message. This is NOT a
    release-policy leak (nothing prohibited is disclosed); it is a
    different, orthogonal quality issue (a wrong model claim) that used
    to be incidentally masked by the old single-target unconditional
    withhold. The repair branch (repair_false_visual_denial_sync) still
    never runs for a restricted target, proven the same way as the
    sibling test above: it is not mocked, so if the gate's ordering ever
    let it run, this test would hit a real network call and fail loud."""
    draft_text = "I'm sorry, I cannot see the image you're referring to."
    conversation_id = "release-gate-visual-denial-single-target"
    stream, save_calls = _setup(
        monkeypatch, policy=_restrictive_policy(), draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(
            stream, conversation_id=conversation_id,
            openFileImages=[stream.OpenFileImagePayload(mediaType="image/jpeg", data="QQ==")],
        ))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"cannot see the image you're referring to" in body
    assert b'"releaseWithheld": false' in body
    assert b'"code": "answer_release_restricted"' not in body
    del save_calls


# ---------------------------------------------------------------------------
# Priority 2, REVISED — real SSE-level proof that the permissive
# per-section release path is DISABLED, not merely hardened. A prior
# version of this suite proved a "clean split" path delivered 5a's
# content while withholding 5b's. That path trusted a model-written
# [[TARGET: ...]] marker as proof of attribution and a clean regex scan
# as proof of no cross-target leak -- both wrong (see test_answer_
# release_validator.py's test_maximally_evasive_smuggling_is_withheld_
# now_that_partial_release_is_disabled and the validator module
# docstring's "REVISED after further review" note). Every mixed-
# permission + restricted-target case below, clean split or evasive
# smuggling alike, now gets the SAME unconditional whole-response
# withhold -- proven over the real SSE stream, not just the validator
# function in isolation.
# ---------------------------------------------------------------------------

def test_mixed_permission_clean_split_is_still_withheld_whole_over_sse(monkeypatch):
    """'Give the full answer for 5a, but only a hint for 5b' -- even for
    this cleanly-sectioned, non-adversarial draft, the permissive partial-
    release path is disabled, so the WHOLE response is withheld. This is
    the honest, safety-first outcome this task requires: a mixed-
    permission request with no independently verifiable target isolation
    gets the same conservative treatment as any other restricted policy,
    never a trusted partial split."""
    draft_text = (
        "[[TARGET: 5a]]\n"
        "Working through the moment balance, the final answer is 42 N.\n"
        "[[TARGET: 5b]]\n"
        "The final answer is 17 N, as derived above.\n"
        "[[END]]\n"
    )
    conversation_id = "release-gate-mixed-structural"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"42 N" not in body  # 5a's content is withheld too -- the safe degrade
    assert b"17 N" not in body and b"17, as derived above" not in body
    assert b'"done": true' in body
    assert b'"releaseStructural": false' in body
    assert b'"releaseWithheld": true' in body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls
    assert b"17 N" not in json.dumps(save_calls).encode()
    assert b"42 N" not in json.dumps(save_calls).encode()


def test_mixed_permission_maximally_evasive_smuggling_is_withheld_over_sse(monkeypatch):
    """THE specific regression this task fixes, proven at the real SSE
    level: a smuggled restricted result with ZERO connecting language and
    ZERO mention of the other target's label -- previously
    indistinguishable from 5a's own genuine content to the old cross-
    target-leak heuristic, and previously confirmed (via test_answer_
    release_validator.py's now-replaced test) to survive into the final
    text. With the permissive path disabled, this gets the same
    unconditional whole-response withhold as every other case -- no
    leaked '17 N' anywhere in the SSE stream, final text, or cache."""
    draft_text = (
        "[[TARGET: 5a]]\n"
        "The answer to 5a is 42 N. 17 N.\n"
        "[[TARGET: 5b]]\n"
        "Think about the forces.\n"
        "[[END]]\n"
    )
    conversation_id = "release-gate-mixed-maximally-evasive"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"17 N" not in body
    assert b"42 N" not in body
    assert b'"done": true' in body
    assert b'"releaseStructural": false' in body
    assert b'"releaseWithheld": true' in body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls
    assert b"17 N" not in json.dumps(save_calls).encode()


def test_mixed_permission_catches_unlabeled_cross_reference_smuggling_over_sse(monkeypatch):
    """Coordinator-review adversarial case, proven at the real route/SSE
    level (not just the helper function in isolation): 5b's prohibited
    result is narrated inside 5a's section via a generic 'second part'
    reference, naming neither '5b' nor matching the strict leak-phrase
    shape. A section marker alone is not proof of attribution -- this
    must still fall back to the whole-response withhold, not leak 17 N
    anywhere in the SSE stream."""
    draft_text = (
        "[[TARGET: 5a]]\n"
        "The answer to 5a is 42 N.\n"
        "Also, for the second part, the value is 17 N.\n"
        "[[TARGET: 5b]]\n"
        "Try applying the formula.\n"
        "[[END]]\n"
    )
    conversation_id = "release-gate-mixed-smuggled"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"17 N" not in body
    assert b"42 N" not in body  # safe degrade: whole response withheld, not a trusted partial split
    assert b'"releaseStructural": false' in body
    assert b'"releaseWithheld": true' in body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls
    assert b"17 N" not in json.dumps(save_calls).encode()


def test_mixed_permission_falls_back_to_whole_withhold_when_model_ignores_sectioning(monkeypatch):
    """Non-regression / safety net: if the model doesn't follow the
    sectioning contract at all (plain prose mixing both targets), this
    must fall back to the EXISTING unconditional whole-response guard --
    never guess a split, never let 5b's result slip through."""
    draft_text = "For 5a the final answer is 42 N. For 5b, the final answer is 17 N."
    conversation_id = "release-gate-mixed-unstructured"
    stream, save_calls = _setup(
        monkeypatch, policy=_mixed_5a_permitted_5b_prohibited_policy(),
        draft_text=draft_text, conversation_id=conversation_id,
    )
    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"42 N" not in body  # even 5a's content is withheld -- safe degrade, not a guessed split
    assert b"17 N" not in body
    assert b'"releaseStructural": false' in body
    assert b'"releaseWithheld": true' in body
    assert b'"code": "answer_release_restricted"' in body
    assert not save_calls


# ---------------------------------------------------------------------------
# Priority 4 — document-scope route-level regression. Previously marked
# below as a deliberate gap ("the request enters the scoped async job
# path and hits an unmocked real network call"). Investigating that gap
# surfaced a REAL, separate bug, fixed and unit-tested in test_scoped_
# extraction.py: stream.py's EARLY job-precreation check (app/services/
# scoped_extraction.classify_scoped_request -> RetrievalMode.COVERAGE ->
# scoped_job_store.create_or_resume_job, which runs BEFORE the SSE
# generator even starts, gated on durableConversation + a specific,
# already-selected document) has its OWN independent "whole/entire +
# noun" lexical classifier (EXHAUSTIVE_COVERAGE_RE), entirely separate
# from grounding_contract.py's _FULL_DOCUMENT_RE -- semantic_intent_
# orchestrator.correct_full_document_scope_false_positive's Phase B fix
# never touches it. Confirmed directly with the real classifier (not
# assumed): both false-positive messages below genuinely produced
# RetrievalMode.COVERAGE before the new app/services/scoped_extraction.
# py fix (correct_exhaustive_coverage_false_positive).
#
# That SPECIFIC job-precreation branch is NOT re-verified at the route
# level here, by deliberate choice, same as before: reaching it needs
# durableConversation=True PLUS an already-selected document
# (documentIds + courseFileScope="specific_files", the only way
# retrievalScope.type becomes anything other than "course"), which
# cascades through an escalating chain of real, unmocked dependencies
# this file's existing harness never needed (document_health.validate_
# active_document_index, an index_revision_status field, an
# unidentified HTTPException past that, and a real commentary-persist
# network attempt) -- confirmed empirically by attempting it, not
# assumed from reading the code. Building that mock surface is
# disproportionate for this pass, matching what the SSE-level gap
# comment originally found for the SAME reason. The fix remains fully
# verified at the unit level (test_scoped_extraction.py, including
# both exact reported messages and the genuine case).
#
# What IS verified below, at the real route level, with NO new mocking
# beyond one trivial top-level function: the SAME underlying "document-
# scope decision must not misfire" requirement, one layer up, via the
# EXISTING grounding_contract.py classifier + Phase B fix, which the
# original gap comment also marked unverified at the route level. A
# genuine full-document request (no document pre-selected) correctly
# asks the student which document to process; the two false-positive
# messages must not.
# ---------------------------------------------------------------------------

def _use_realistic_deterministic_interpretation(monkeypatch):
    """_setup's shared fake_interpret_turn_authoritatively hardcodes
    resolved_intent.conversation="new" for every message (fine for the
    release-gate tests it was built for, which don't care). The
    document-scope correction (correct_full_document_scope_false_
    positive) specifically branches on conversation being "correction"/
    "rejection"/"follow_up" (or a lexical fallback that doesn't cover
    German rejection phrasing at all) -- so proving it at the route
    level needs the REAL deterministic adapter's actual classification,
    not a hardcoded stand-in. Still zero model calls (mode="off")."""
    from app.services import semantic_intent_orchestrator

    def realistic_fake(*, question, dialogue_base, resolved_access, **_kwargs):
        from app.services.diagnostic_policy import adapt_deterministic_intent
        from app.services.policy_compiler import compile_policy
        from app.services.student_intent import interpret_student_intent

        student_intent = interpret_student_intent(
            question, dialogue=dialogue_base, resolved_access=resolved_access, mode="off",
        )
        resolved_intent = adapt_deterministic_intent(
            message=question, dialogue=dialogue_base, student_intent=student_intent,
        )
        policy = compile_policy(resolved_intent)
        return semantic_intent_orchestrator.AuthoritativeInterpretation(
            dialogue=dialogue_base, resolved_intent=resolved_intent, execution_policy=policy,
            used_unified_call=False, unified_call_succeeded=False, compiled_policy_by_target={},
        )

    monkeypatch.setattr(
        semantic_intent_orchestrator, "interpret_turn_authoritatively", realistic_fake,
    )


@pytest.mark.parametrize("message", [
    "You didn't answer the whole Aufgabe. Parts a and c are missing.",
    "Ich möchte keine Zusammenfassung des gesamten PDFs.",
])
def test_correction_or_rejection_complaint_does_not_trigger_full_document_scope_over_route(monkeypatch, message):
    """The false-positive messages must not be treated as full-document-
    scope requests at all: no "which document?" prompt, no error, a
    normal streamed answer -- proven via the real /ask-stream route, not
    just the lower-level classifier/correction functions in isolation
    (both already unit-tested in test_semantic_intent_orchestrator.py)."""
    conversation_id = f"document-scope-{abs(hash(message))}"
    stream, _save_calls = _setup(
        monkeypatch, policy=_permissive_policy(), draft_text="Here is a focused answer.",
        conversation_id=conversation_id,
    )
    _use_realistic_deterministic_interpretation(monkeypatch)

    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id, question=message))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b"FULL_DOCUMENT_SCOPE_REQUIRED" not in body
    assert b'"done": true' in body


def test_genuine_full_document_request_still_asks_which_document_over_route(monkeypatch):
    """Non-regression: a GENUINE whole-document request, with no
    document pre-selected, must still be recognized as full-document
    scope at the route level and prompt for which document to process
    -- the correction/rejection narrowing above must never overreach
    into blocking real full-document intent."""
    message = "Please summarize the entire PDF."
    conversation_id = "document-scope-genuine"
    stream, _save_calls = _setup(
        monkeypatch, policy=_permissive_policy(), draft_text="irrelevant for this path",
        conversation_id=conversation_id,
    )
    monkeypatch.setattr(
        stream, "_load_authorized_course_candidates",
        lambda *_a, **_k: [{"id": DOCUMENT_ID, "file_name": "exam.pdf"}],
    )

    try:
        body = asyncio.run(_run(stream, conversation_id=conversation_id, question=message))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()

    assert b'"code": "FULL_DOCUMENT_SCOPE_REQUIRED"' in body
    assert b'"resolvedDocumentAccess": "full_document"' in body


# ---------------------------------------------------------------------------
# Cache-policy interaction (item 2 of the 2026-10-20 live-eval follow-up
# round) -- proving, at the real cache-lookup call site this route uses
# (app/services/cache.lookup_answer/question_hash, not a narrower hash-only
# helper test), that an answer cached under one compiled ExecutionPolicy can
# never be replayed once the SAME question's policy changes. stream.py
# already folds execution_policy.policy_hash into cache_key_kwargs
# (stream.py ~4634) before ever calling lookup_answer/save_answer -- this
# section's job is to prove that construction, not to add a new one.
#
# This harness's own ``_setup`` mocks ``cache.lookup_answer``/``cache.
# save_answer``/``cache.fetch_course_version_hash`` directly on the
# ``cache`` module -- harmless for every OTHER test in this file (none of
# them reach ``cacheable=True``, since they all set ``openFileContext``,
# same documented reason ``test_permitted_final_answer_still_streams_
# normally`` already gives), but it means those mocks never actually
# reach stream.py's own call sites: stream.py imports those three names
# directly (``from ..services.cache import fetch_course_version_hash,
# lookup_answer, save_answer``), so it holds its OWN binding, exactly the
# same "module holds its own binding" issue this file's docstring already
# calls out for ``retrieve_exercise_block``. The tests below patch ``cache.
# get_supabase`` instead (cache.py's OWN binding, which its internal calls
# do resolve against) and leave the real ``lookup_answer``/``question_hash``
# running, so the real hashing/policy_hash logic is what gets exercised.
#
# A real end-to-end save-then-replay round trip through this exact mocked
# route additionally requires satisfying several PRODUCT gates unrelated to
# caching (high-risk numeric-answer validation, document-indexing-pending
# detection, fast-lane-vs-deep-reasoning routing) that have nothing to do
# with policy_hash correctness and would make this test fragile and
# coupled to unrelated internals. Instead, this seeds the fake cache store
# with the exact hash the real lookup call computes for turn 1 (standing in
# for a real save, which is covered as its own concern elsewhere) and
# proves the lookup for an otherwise-IDENTICAL turn 2 request misses once
# only the compiled policy changes -- the real discriminating mechanism
# under test.
# ---------------------------------------------------------------------------

class _FakeCacheTable:
    """Minimal in-memory stand-in for the two tables this test's real call
    sites actually touch: ``ai_answer_cache`` (``cache.lookup_answer``)
    and ``documents`` (``cache.fetch_course_version_hash``, needed first
    to produce the ``version_hash`` lookup_answer requires) -- not a
    general fake Supabase client."""

    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._op = None
        self._filters: dict = {}

    def select(self, *_a, **_k):
        self._op = "select"
        return self

    def eq(self, key, value):
        self._filters[key] = value
        return self

    def limit(self, _n):
        return self

    def execute(self):
        if self._name == "documents":
            # One document with a fixed hash -- enough for fetch_course_
            # version_hash to produce a real, non-empty version_hash.
            return type("R", (), {"data": [{"document_hash": "rev-1", "updated_at": "t0"}]})()
        if self._op == "select":
            key = (
                self._filters.get("user_id"), self._filters.get("course_id"),
                self._filters.get("question_hash"), self._filters.get("document_version_hash"),
            )
            row = self._store.get(key)
            return type("R", (), {"data": [row] if row else []})()
        return type("R", (), {"data": []})()


class _FakeSupabaseForCache:
    def __init__(self):
        self.store: dict = {}

    def table(self, name):
        return _FakeCacheTable(self.store, name)


def test_answer_cached_under_a_permissive_policy_is_not_replayed_once_the_policy_turns_restrictive(monkeypatch):
    """Turn 1 (no restriction, permissive compiled policy) gets a cache
    row seeded under the real hash its own lookup call computed. Turn 2
    asks the EXACT SAME question/user/course/document/context -- the only
    difference is the compiled policy now prohibits the final answer for
    the active target (e.g. the student just said "don't reveal the
    answer" for it). The turn-2 request must MISS, never replay turn 1's
    cached (permissive) answer."""
    from app.services import cache as cache_mod

    fake_sb = _FakeSupabaseForCache()
    monkeypatch.setattr(cache_mod, "get_supabase", lambda: fake_sb)
    real_lookup = cache_mod.lookup_answer
    real_question_hash = cache_mod.question_hash
    real_fetch_version = cache_mod.fetch_course_version_hash
    lookup_calls: list[tuple[dict, dict | None]] = []
    hashes: list[str] = []

    def spy_question_hash(*args, **kwargs):
        h = real_question_hash(*args, **kwargs)
        hashes.append(h)
        return h

    monkeypatch.setattr(cache_mod, "question_hash", spy_question_hash)

    def _ask(policy, conversation_id):
        stream, _save_calls = _setup(
            monkeypatch, policy=policy, draft_text="irrelevant for this path",
            conversation_id=conversation_id,
        )
        # Re-point stream.py's OWN bindings -- patching the cache module's
        # attributes (what _setup does) never reaches these; see this
        # section's docstring above.
        monkeypatch.setattr(stream, "fetch_course_version_hash", real_fetch_version)

        def spy_lookup(**kwargs):
            result = real_lookup(**kwargs)
            lookup_calls.append((kwargs, result))
            return result

        monkeypatch.setattr(stream, "lookup_answer", spy_lookup)
        # Built directly rather than via this file's shared ``_run`` --
        # that helper hardcodes activeDocumentId/openFileContext/
        # visiblePage to the values the OTHER tests in this file need
        # (deliberately NOT cacheable, see this section's docstring),
        # which would collide with the values this test needs instead.
        payload = stream.AskStreamRequest(
            courseId="course-1",
            activeDocumentId=None,
            question="Explain Newton's second law.",
            visiblePage=None,
            sourceMode="course_files",
            openFileContext=None,
            conversationId=conversation_id,
            conversationGeneration=1,
        )
        async def _call_and_drain():
            response = await stream.ask_stream_endpoint(payload, {"id": USER_ID})
            return b"".join([event async for event in response.body_iterator])

        try:
            body = asyncio.run(_call_and_drain())
        finally:
            from app.config import get_settings
            get_settings.cache_clear()
        return body

    _ask(_permissive_policy(), "cache-policy-turn-1")
    turn1_kwargs, turn1_result = lookup_calls[-1]
    assert turn1_kwargs["policy_hash"] == "permitted-5b"
    assert turn1_result is None  # nothing cached yet

    # Seed the store under the EXACT hash turn 1's own lookup computed --
    # standing in for turn 1's answer having been saved (see docstring).
    h1 = hashes[-1]
    key1 = (turn1_kwargs["user_id"], turn1_kwargs["course_id"], h1, turn1_kwargs["version_hash"])
    fake_sb.store[key1] = {
        "id": "seeded-turn-1", "usage_count": 0,
        "answer_json": {"answer": "TURN-1-PERMISSIVE-CACHED-ANSWER"},
    }

    # Sanity check: an IDENTICAL request (same permissive policy_hash)
    # DOES find the seeded row -- proves the harness/seed is valid, not
    # just vacuously true because nothing is ever found.
    _ask(_permissive_policy(), "cache-policy-turn-1-repeat")
    _repeat_kwargs, repeat_result = lookup_calls[-1]
    assert repeat_result == {"answer": "TURN-1-PERMISSIVE-CACHED-ANSWER"}

    # Turn 2: same question/user/course/document/context, but the policy
    # for this target is now restrictive.
    _ask(_restrictive_policy(), "cache-policy-turn-2")
    turn2_kwargs, turn2_result = lookup_calls[-1]
    assert turn2_kwargs["policy_hash"] == "restricted-5b"
    assert turn2_result is None, (
        "turn 2's restrictive policy must never be served turn 1's "
        "permissive cached answer"
    )

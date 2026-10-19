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
    # A clean-looking draft with no recognizable leak SHAPE at all (no
    # "final answer is", no boxed{}, no table, no verification framing) —
    # exactly the case the Phase D validator's own docstring says a regex
    # scan alone cannot catch. The fix must withhold this too, precisely
    # because restriction, not a pattern match, is what triggers it.
    ("The beam carries 42 N at the support.", b"The beam carries 42 N at the support"),
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
    loud rather than hanging) network call instead of silently passing."""
    draft_text = "I'm sorry, I cannot see the image you're referring to."
    conversation_id = "release-gate-visual-denial"
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

    assert b"cannot see the image" not in body
    assert b"withholding" in body.lower() or b"zur" in body.lower()
    assert b'"code": "answer_release_restricted"' in body
    assert b'"done": true' in body
    assert not save_calls


# ---------------------------------------------------------------------------
# Document-scope false-positive fix (spec §4C) — NOT re-verified here at
# the SSE/route level, by deliberate choice, not oversight. Both the two
# false-positive messages and the genuine full-document request are
# phrased as a correction/rejection (that's what makes them trigger
# resolve_document_access's lexical bug in the first place), and that
# relation forces this specific route into the scoped async job-queue
# worker path (RetrievalMode.COVERAGE -> scoped_job_store.
# create_or_resume_job) rather than the direct synchronous path every
# other test in this file exercises — a real, unmocked DB/network call
# with no existing route-level test scaffold to borrow (checked
# test_scoped_worker_contract.py / test_scoped_job_worker_execute.py:
# neither mocks the route, only the worker in isolation). Building that
# mock surface from scratch is out of scope for this pass. The fix
# itself remains verified at the unit level, where it was already
# thoroughly covered before this commit: test_semantic_intent_
# orchestrator.py::test_incomplete_answer_complaint_is_not_routed_to_
# full_document, ::test_explicit_rejection_of_full_document_summary_is_
# not_routed_to_full_document, and ::test_genuine_full_document_request_
# still_works all pass unchanged. Named explicitly in the final report
# as an untested (at the route level) path, not silently assumed covered.
# ---------------------------------------------------------------------------

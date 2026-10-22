"""Regression for the 2026-10-21 production incident: a real request
(``ncb_msg_mvibafuc_mz2in7jf``, confirmed via server logs) spent 100+
unbounded seconds inside primary retrieval during a transient Supabase
slowdown, then got cancelled by something unrelated to retrieval itself
with no error ever shown to the student (the stream closed with
``terminal_event_sent=False``). ``app/routers/stream.py``'s retrieval
awaits are now wrapped in ``_await_bounded`` (``_RETRIEVAL_TIMEOUT_
SECONDS``), so a genuine stall now fails fast with an honest, retryable
error instead of hanging until something else notices.

Follow-up (2026-10-22): a single request's retrieval phase can call
``_await_bounded`` up to THREE times in sequence (the FAST_GROUNDED
probe, its own escalation re-retrieval, then the multi-item evidence
call) -- each independently getting its own fresh
``_RETRIEVAL_TIMEOUT_SECONDS`` would silently let the TOTAL student-
visible wait climb to up to 3x the configured bound, exactly the kind
of gap a single per-call timeout looks like it closes but doesn't.
``retrieval_deadline`` (one shared ``time.monotonic()`` timestamp
threaded through every call via ``_await_bounded``'s ``deadline``
param) closes that; see its own docstring and
test_cumulative_retrieval_deadline_is_shared_not_reset_per_call below.

Design: exercises the REAL /ask-stream route and REAL retrieval gather
(not a stubbed-out `_prepare_ask_stream_response`) -- only one retrieval
function is made artificially slow (synchronous `time.sleep`, matching
how a real blocking Supabase call behaves inside `run_in_threadpool`),
and the timeout constant is shrunk so this test doesn't need to wait out
the real production bound.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time
import uuid

import tests.test_live_eval_remediation_acceptance as base
from app.routers.stream import ExecutionLane, _await_bounded
from app.services import retrieval


def test_a_genuinely_stuck_retrieval_fails_fast_with_a_retryable_error(monkeypatch):
    stream, _ = base._setup(monkeypatch)
    monkeypatch.setattr(stream, "_RETRIEVAL_TIMEOUT_SECONDS", 0.2)

    doc_id = str(uuid.uuid4())
    chunk = retrieval.RetrievedChunk(
        chunk_id="c-1", document_id=doc_id, page_start=1, page_end=1,
        text="Some course content.", score=1.0, similarity=1.0,
        chunk_type="notes", section_title=None,
    )

    def _stuck_retrieve_routed_chunks(**_kw):
        time.sleep(2.0)  # far longer than the 0.2s timeout above
        return [chunk]

    monkeypatch.setattr(stream, "retrieve_routed_chunks", _stuck_retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", _stuck_retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **kw: [chunk])
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **kw: type("R", (), {"chunks": [chunk], "evidence": [], "to_dict": lambda self: {}})(),
    )
    monkeypatch.setattr(stream, "_load_authorized_documents", lambda *_: {
        doc_id: {
            "id": doc_id, "user_id": base.USER_ID, "course_id": "course-1",
            "file_name": "notes.pdf", "storage_path": "synthetic/notes.pdf",
            "document_hash": "rev-1", "processing_status": "ready",
            "page_count": 1, "chunk_count": 1,
        },
    })
    base._install_capturing_transport(monkeypatch, intent_response_json=None, draft_text="n/a")

    async def run():
        payload = stream.AskStreamRequest(
            courseId="course-1", activeDocumentId=doc_id, question="explain this to me",
            sourceMode="course_files", conversationId="retrieval-timeout-test",
            conversationGeneration=1, previousTurns=[],
            visiblePage=1, openFileContext="Some course content.",
        )
        response = await stream.ask_stream_endpoint(payload, {"id": base.USER_ID})
        return b"".join([event async for event in response.body_iterator])

    started = time.perf_counter()
    try:
        body = asyncio.run(asyncio.wait_for(run(), timeout=15.0))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    elapsed = time.perf_counter() - started

    # Tight to the configured 0.2s deadline, not a loose ceiling that would
    # let a multi-second regression slip through unnoticed. Measured
    # locally over 5 runs: 0.33-0.42s (~0.15-0.22s of real route overhead
    # -- preflight, auth, dialogue resolution -- on top of the 0.2s
    # timeout itself). +1.5s gives a generous margin for a loaded/CI
    # machine while still catching "it waited out most of the real 2s
    # sleep" (the exact shape of the original production bug) by a wide
    # margin.
    assert 0.2 <= elapsed <= 1.7, (
        f"must fail close to the configured 0.2s deadline (route overhead "
        f"included), not hang anywhere near the full 2s the mock sleeps: {elapsed:.2f}s"
    )
    assert b'"code": "retrieval_timed_out"' in body, (
        f"a genuine retrieval stall must produce an honest, retryable error, "
        f"never a silent hang: {body!r}"
    )
    assert b'"retryable": true' in body


def test_cumulative_retrieval_deadline_is_shared_not_reset_per_call():
    """Direct, deterministic proof of the mechanism (not through the full
    HTTP route, which has enough real preflight/auth/dialogue-resolution
    overhead to make a tight two-call timing assertion noisy): two
    sequential ``_await_bounded`` calls sharing one ``deadline`` must
    together take roughly ONE timeout's worth of time, not two. A call
    that consumes most of the shared budget must leave the NEXT call only
    the remainder, not a fresh full timeout -- this is exactly the gap
    that let a single request's retrieval phase (FAST_GROUNDED probe ->
    its own escalation retry -> multi-item evidence call, up to 3 awaits)
    silently climb to up to 3x _RETRIEVAL_TIMEOUT_SECONDS even with each
    individual await correctly bounded in isolation."""
    async def _slow(seconds: float):
        await asyncio.sleep(seconds)
        return "done"

    async def run():
        deadline = time.monotonic() + 0.3
        started = time.perf_counter()
        # First call: consumes 0.2s of the 0.3s shared budget, succeeds
        # (0.2s < remaining 0.3s at the time it starts).
        result = await _await_bounded(_slow(0.2), stage="retrieval", deadline=deadline)
        assert result == "done"
        # Second call: only ~0.1s of shared budget is left. Asks for 2.0s
        # -- with a correctly-shared deadline this times out almost
        # immediately after the first call finishes, not after another
        # fresh 0.3s.
        from app.routers.stream import TutorPipelineError
        try:
            await _await_bounded(_slow(2.0), stage="retrieval", deadline=deadline)
            raised = False
        except TutorPipelineError:
            raised = True
        elapsed = time.perf_counter() - started
        return raised, elapsed

    raised, elapsed = asyncio.run(run())
    assert raised, "the second call must time out once the shared budget is exhausted"
    # Shared-deadline total: ~0.3s (one timeout's worth). Reset-per-call
    # (the bug): ~0.2 + 0.3 = 0.5s minimum (second call would get its own
    # fresh 0.3s on top of the first call's 0.2s). 0.45s cleanly separates
    # the two without being sensitive to event-loop scheduling jitter at
    # the millisecond level.
    assert elapsed < 0.45, (
        f"two sequential calls sharing one deadline must together take ~0.3s "
        f"(one timeout's worth), not ~0.5s (a fresh timeout per call): {elapsed:.3f}s"
    )


def test_fast_grounded_escalation_total_wait_stays_near_one_deadline_not_two(monkeypatch):
    """End-to-end version of the test above, through the REAL /ask-stream
    route: forces the FAST_GROUNDED lane (same monkeypatch technique
    test_stream_route_multiturn.py already uses for this exact escalation
    branch), makes its probe retrieval return no usable evidence (forcing
    the real escalation code path at "A failed fast probe is only a
    routing attempt..."), then makes the escalation's own re-retrieval
    call genuinely slow. The student-visible total must stay close to ONE
    configured timeout, not stack two.

    Both the probe AND the escalation call are made slow (not just the
    escalation) -- with only the escalation call slow, a shared-deadline
    fix and a reset-per-call bug are nearly indistinguishable (the probe
    barely touches the budget either way, so the escalation call gets
    ~the full timeout under BOTH implementations). The probe consuming
    MOST of the shared budget before the escalation call runs is what
    actually separates "remaining time only" from "a fresh timeout"."""
    stream_mod, _ = base._setup(monkeypatch)
    monkeypatch.setattr(stream_mod, "_RETRIEVAL_TIMEOUT_SECONDS", 1.0)

    doc_id = str(uuid.uuid4())

    _real_resolve_execution_plan = stream_mod.resolve_execution_plan

    def _forced_fast_grounded(*args, **kwargs):
        task_profile, plan = _real_resolve_execution_plan(*args, **kwargs)
        forced_plan = dataclasses.replace(
            plan, executionLane=ExecutionLane.FAST_GROUNDED, initialLane=ExecutionLane.FAST_GROUNDED,
        )
        return task_profile, forced_plan

    monkeypatch.setattr(stream_mod, "resolve_execution_plan", _forced_fast_grounded)

    call_count = {"n": 0}

    def _retrieve_routed_chunks(**_kw):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # The FAST_GROUNDED probe itself: consumes most of the shared
            # 1.0s budget (0.85s) before returning nothing, so
            # fast_grounded_evidence_is_sufficient is False and the real
            # escalation branch runs next with only ~0.15s left of a
            # correctly-shared deadline.
            time.sleep(0.85)
            return []
        # The escalation's own re-retrieval: genuinely slow, deliberately
        # exceeding whatever remains of the shared budget.
        time.sleep(5.0)
        return []

    monkeypatch.setattr(stream_mod, "retrieve_routed_chunks", _retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", _retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **kw: [])
    monkeypatch.setattr(stream_mod, "_load_authorized_documents", lambda *_: {
        doc_id: {
            "id": doc_id, "user_id": base.USER_ID, "course_id": "course-1",
            "file_name": "notes.pdf", "storage_path": "synthetic/notes.pdf",
            "document_hash": "rev-1", "processing_status": "ready",
            "page_count": 1, "chunk_count": 1,
        },
    })
    base._install_capturing_transport(monkeypatch, intent_response_json=None, draft_text="n/a")

    async def run():
        payload = stream_mod.AskStreamRequest(
            courseId="course-1", activeDocumentId=doc_id, question="explain this to me",
            sourceMode="course_files", conversationId="fast-grounded-escalation-timeout-test",
            conversationGeneration=1, previousTurns=[],
            visiblePage=1, openFileContext="Some course content.",
        )
        response = await stream_mod.ask_stream_endpoint(payload, {"id": base.USER_ID})
        return b"".join([event async for event in response.body_iterator])

    started = time.perf_counter()
    try:
        body = asyncio.run(asyncio.wait_for(run(), timeout=15.0))
    finally:
        from app.config import get_settings
        get_settings.cache_clear()
    elapsed = time.perf_counter() - started

    assert call_count["n"] >= 2, "the escalation path must actually have run a second retrieval call"
    assert b'"code": "retrieval_timed_out"' in body, (
        f"the escalation's own stall must still produce an honest, retryable error: {body!r}"
    )
    # Shared deadline: probe (0.85s) + remainder (~0.15s) = ~1.0s, plus
    # realistic route overhead (~0.2-0.4s, consistent with the single-call
    # test above) = ~1.2-1.4s. Reset-per-call (the bug): probe (0.85s,
    # succeeds within its OWN fresh 1.0s) + escalation getting a fresh
    # 1.0s = ~1.85s, plus overhead = ~2.05-2.25s. 1.8s sits cleanly between
    # the two, closer to the fixed side, with real margin on both sides.
    assert elapsed < 1.8, (
        f"the escalation path's total wait must stay close to the single configured "
        f"deadline (~1.0-1.4s here), not stack a second one (~1.85-2.25s): {elapsed:.2f}s"
    )

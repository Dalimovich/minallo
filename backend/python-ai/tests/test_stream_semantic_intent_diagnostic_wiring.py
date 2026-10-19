"""Route-level tests for Milestone 3 PR 2 — wiring diagnostic_policy.py's
behavior-inert ExecutionPolicy computation into the real /ask-stream path.

These exercise the actual call site inside ask_stream_endpoint (added right
after `student_intent = intent_for_router(...)`), not just the
diagnostic_policy unit tests, which never touch the route at all. They
prove the four feature-mode contracts from
docs/semantic-intent-milestone-3-plan.md:

- OFF never even calls the new helper (zero extra work, not just
  "computes but discards").
- SHADOW computes and logs a privacy-safe record but never changes the
  SSE output, cache, or persistence behavior.
- A synthetic course-rail conversationId, or client-supplied
  previousTurns, is never treated as trusted history (conversation_id
  stays None, the real durable store is never touched for it) — but it
  is also never mislabeled "history_free"; only a request with neither
  gets that label. Everything else diagnoses as "unavailable".
- A slow durable-history lookup (validate + messages + request rows —
  up to 4 sequential DB round trips) is bounded by a timeout and can
  never meaningfully delay the student's response.
- Any failure inside the new diagnostic layer degrades silently; the
  student's response is unaffected.

`_prepare_ask_stream_response` (the deep retrieval/generation pipeline) is
replaced wholesale, same pattern as
test_grounding_failure_fallback.test_deferred_error_terminal_survives_
state_write_outage — the diagnostic call site runs entirely in the
preflight section *before* that function is ever reached, so stubbing it
out keeps these tests focused on the wiring itself, not retrieval/
generation. `interpret_student_intent` runs for real (not mocked)
because this exact question never trips _needs_semantic_path — see
test_semantic_intent_interpretation_runs_off_the_event_loop, which relies
on the same fact — so no OpenAI client is ever constructed here.

LIMITATION: because `_prepare_ask_stream_response` is stubbed out, these
tests prove the diagnostic wiring is inert AT THE PREFLIGHT BOUNDARY —
it can't gate or change what that function is called with, and its
result can't reach it. They do NOT independently exercise the real
retrieval/generation/cache/persistence code inside
`_prepare_ask_stream_response` itself with SHADOW mode on — that would
need a full-pipeline test in the style of
test_stream_route_multiturn.py, which this file deliberately does not
attempt to build. The SHADOW/OFF response-parity test below is the
strongest signal here, and it only covers the preflight + stub-response
shape, not a real generation run.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest

from fastapi.responses import StreamingResponse

from test_conversational_evidence_resolution import (
    _consume, _mock_tutor_state, _stream_router_common_mocks,
)

QUESTION = "What is torsion?"


@pytest.fixture(autouse=True)
def _reset_diagnostic_task_tracking():
    """_semantic_intent_diagnostic_tasks is module-level state shared across
    the whole test session (app.routers.stream is imported once) — clear
    it before and after every test so no test's leftover tasks can make
    another test see phantom capacity usage."""
    from app.routers import stream as stream_router
    stream_router._semantic_intent_diagnostic_tasks.clear()
    yield
    stream_router._semantic_intent_diagnostic_tasks.clear()


async def _fake_prepare(*_args, **_kwargs):
    async def body():
        yield b'data: {"t": "Torsion is a twisting load."}\n\n'
        yield b'data: {"done": true, "sources": []}\n\n'

    return StreamingResponse(body(), media_type="text/event-stream")


def _setup(monkeypatch):
    router = _stream_router_common_mocks(monkeypatch)
    _mock_tutor_state(monkeypatch)
    monkeypatch.setattr(router, "_prepare_ask_stream_response", _fake_prepare)
    return router


async def _consume_and_drain(router, request, request_id):
    """The diagnostic now runs as a bounded background task (see
    _schedule_semantic_intent_diagnostic_policy) — never awaited on the
    response path. Any test asserting on the diagnostic's own side
    effects (log lines, mocked DB calls) must explicitly wait for it to
    finish after the SSE response completes, since the response itself
    no longer waits for it."""
    body = await _consume(router, request, request_id)
    pending = [t for t in router._semantic_intent_diagnostic_tasks]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    return body


def test_off_mode_never_invokes_diagnostic_wiring(monkeypatch):
    """SEMANTIC_INTENT_MODE defaults to off — the new helper must not even
    be called, so OFF genuinely does zero extra work."""
    router = _setup(monkeypatch)

    def _must_not_be_called(**_kwargs):
        raise AssertionError("diagnostic wiring must never run when SEMANTIC_INTENT_MODE=off")

    monkeypatch.setattr(router, "_schedule_semantic_intent_diagnostic_policy", _must_not_be_called)

    body = asyncio.run(_consume(
        router, router.AskStreamRequest(courseId="", question=QUESTION, sourceMode="internet"),
        "diagnostic-off-mode",
    ))
    assert b'"done": true' in body


def test_shadow_mode_genuinely_new_request_is_history_free(monkeypatch):
    """A brand-new request — no conversationId, no previousTurns at all —
    is the only case that's genuinely history_free."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)

        def _must_not_be_called(**_kwargs):
            raise AssertionError("a request with no conversationId must never touch the real durable store")

        monkeypatch.setattr(conversation_store, "validate_durable_conversation", _must_not_be_called)
        monkeypatch.setattr(conversation_store, "get_durable_conversation_messages", _must_not_be_called)

        logged = []
        monkeypatch.setattr(router.log, "info", lambda *a, **_k: logged.append(a))

        body = asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(courseId="", question=QUESTION, sourceMode="internet"),
            "diagnostic-history-free",
        ))
        assert b'"done": true' in body

        diagnostic_logs = [a for a in logged if a and "semantic_intent_diagnostic_policy" in str(a[0])]
        assert diagnostic_logs, "expected one diagnostic_policy log line"
        assert diagnostic_logs[0][2] == "history_free"
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize("payload_kwargs", [
    # A course-rail-style synthetic conversationId, non-durable.
    {"conversationId": "course:1:file:2:sidepanel"},
    # No conversationId at all, but the client supplied previousTurns —
    # these must never be read into the ledger, and the request is NOT
    # history_free just because there's no durable id.
    {"previousTurns": [
        {"role": "user", "text": "Explain torsion."},
        {"role": "assistant", "text": "Torsion twists a shaft."},
    ]},
])
def test_shadow_mode_non_durable_context_is_unavailable_not_history_free(monkeypatch, payload_kwargs):
    """Neither a synthetic conversationId nor client-supplied previousTurns
    is proof of "no history" — both are unverified, not trusted, and must
    never cause a real conversation_store lookup either."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)

        def _must_not_be_called(**_kwargs):
            raise AssertionError(
                "unverified, non-durable context must never reach the real durable store"
            )

        monkeypatch.setattr(conversation_store, "validate_durable_conversation", _must_not_be_called)
        monkeypatch.setattr(conversation_store, "get_durable_conversation_messages", _must_not_be_called)

        logged = []
        monkeypatch.setattr(router.log, "info", lambda *a, **_k: logged.append(a))

        body = asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(
                courseId="", question=QUESTION, sourceMode="internet", **payload_kwargs,
            ),
            "diagnostic-unavailable-non-durable",
        ))
        assert b'"done": true' in body

        diagnostic_logs = [a for a in logged if a and "semantic_intent_diagnostic_policy" in str(a[0])]
        assert diagnostic_logs, "expected one diagnostic_policy log line"
        assert diagnostic_logs[0][2] == "unavailable"
    finally:
        get_settings.cache_clear()


def test_shadow_mode_uses_the_real_durable_store_when_flagged(monkeypatch):
    """A genuinely durable conversation (durableConversation=True) is the
    one case the diagnostic layer is allowed to look up — via the real,
    ownership-verified conversation_store, never payload.previousTurns."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_: None)
        monkeypatch.setattr(conversation_store, "append_tutor_commentary", lambda **_: None)

        calls = []

        def fake_validate(*, user_id, conversation_id):
            calls.append(("validate", user_id, conversation_id))
            return True

        def fake_get_messages(*, user_id, conversation_id):
            calls.append(("get_messages", user_id, conversation_id))
            return []

        monkeypatch.setattr(conversation_store, "validate_durable_conversation", fake_validate)
        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", fake_get_messages,
        )

        def _must_not_be_called(**_kwargs):
            raise AssertionError(
                "the diagnostic must use the lightweight diagnostics-only fetch, "
                "never the full get_durable_conversation_messages (it would re-"
                "validate ownership redundantly and join ai_tutor_requests for no reason)"
            )

        monkeypatch.setattr(conversation_store, "get_durable_conversation_messages", _must_not_be_called)

        logged = []
        monkeypatch.setattr(router.log, "info", lambda *a, **_k: logged.append(a))

        conversation_id = "00000000-0000-4000-8000-00000000d007"
        body = asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(
                courseId="", question=QUESTION, sourceMode="internet",
                durableConversation=True, conversationId=conversation_id,
                clientMessageId="client-msg-1", assistantMessageId="assistant-msg-1",
            ),
            "diagnostic-durable-store",
        ))
        assert b'"done": true' in body

        expected_user_id = "00000000-0000-4000-8000-000000000099"  # _consume's fixed user id
        assert ("validate", expected_user_id, conversation_id) in calls
        assert ("get_messages", expected_user_id, conversation_id) in calls
        assert calls.count(("validate", expected_user_id, conversation_id)) == 1, (
            "ownership must be validated exactly once per diagnostic now — the "
            "lightweight fetch must not re-validate it a second time"
        )

        diagnostic_logs = [a for a in logged if a and "semantic_intent_diagnostic_policy" in str(a[0])]
        assert diagnostic_logs, "expected one diagnostic_policy log line"
        assert diagnostic_logs[0][2] == "durable_store"
    finally:
        get_settings.cache_clear()


def test_diagnostic_wiring_runs_exactly_once_per_request(monkeypatch):
    """Guards against a future edit accidentally calling the diagnostic
    pipeline more than once per turn (e.g. inside a retry loop) or zero
    times when it should run — either would misrepresent the "at most
    one classification call per turn" budget this layer is diagnosing
    against (note: compile_diagnostic_policy itself makes no model call
    at all — see diagnostic_policy.test_module_makes_no_model_calls —
    this is purely about the diagnostic computation's own call count)."""
    from app.config import get_settings
    from app.services import diagnostic_policy

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        real_compile = diagnostic_policy.compile_diagnostic_policy
        calls = []

        def _counted(**kwargs):
            calls.append(kwargs)
            return real_compile(**kwargs)

        monkeypatch.setattr(diagnostic_policy, "compile_diagnostic_policy", _counted)

        body = asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(courseId="", question=QUESTION, sourceMode="internet"),
            "diagnostic-call-count",
        ))
        assert b'"done": true' in body
        assert len(calls) == 1
    finally:
        get_settings.cache_clear()


def test_slow_durable_history_lookup_is_bounded_by_a_timeout(monkeypatch):
    """The diagnostic now runs as a bounded background task, never awaited
    on the response path (a production Hetzner measurement found the real
    lookup exceeds 1.0s often enough that even the old inline-awaited
    timeout wasn't good enough — see _run_semantic_intent_diagnostic_policy's
    docstring). A slow lookup must therefore not delay the response AT ALL
    (not just "under the timeout bound"), and the diagnostic itself still
    gives up and logs a timeout after its own bound, rather than running
    forever. Shrinks the timeout constant so this test doesn't need to
    wait out the real production bound."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(router, "_SEMANTIC_INTENT_DIAGNOSTIC_TIMEOUT_SECONDS", 0.05)
        monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_: None)
        monkeypatch.setattr(conversation_store, "append_tutor_commentary", lambda **_: None)
        monkeypatch.setattr(conversation_store, "validate_durable_conversation", lambda **_: True)

        def _slow_get_messages(**_kwargs):
            time.sleep(0.3)  # much slower than the 0.05s diagnostic timeout above
            return []

        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", _slow_get_messages,
        )

        warned = []
        monkeypatch.setattr(router.log, "warning", lambda *a, **_k: warned.append(a))

        async def _run():
            request_started = time.perf_counter()
            response_body = await _consume(
                router, router.AskStreamRequest(
                    courseId="", question=QUESTION, sourceMode="internet",
                    durableConversation=True, conversationId="00000000-0000-4000-8000-00000000d099",
                    clientMessageId="client-msg-slow", assistantMessageId="assistant-msg-slow",
                ),
                "diagnostic-slow-history",
            )
            response_elapsed = time.perf_counter() - request_started
            # The response is already back at this point -- only now do we
            # wait for the still-slow background diagnostic to finish, to
            # observe its own eventual timeout without it ever having
            # touched the response above.
            pending = list(router._semantic_intent_diagnostic_tasks)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            return response_body, response_elapsed

        body, elapsed = asyncio.run(_run())

        assert b'"done": true' in body
        assert elapsed < 0.2, (
            f"the slow diagnostic lookup delayed the response by {elapsed:.2f}s -- "
            "it must not be on the critical path at all, not just under the timeout"
        )
        assert any("semantic_intent_diagnostic_policy_timeout" in str(a[0]) for a in warned)
    finally:
        get_settings.cache_clear()


def test_shadow_mode_response_matches_off_mode_response(monkeypatch):
    """The core behavior-inertness guarantee: identical inputs produce an
    identical SSE response whether SEMANTIC_INTENT_MODE is off or shadow."""
    from app.config import get_settings

    def _run(mp, mode: str) -> bytes:
        if mode != "off":
            mp.setenv("SEMANTIC_INTENT_MODE", mode)
            get_settings.cache_clear()
        router = _setup(mp)
        try:
            return asyncio.run(_consume_and_drain(
                router, router.AskStreamRequest(courseId="", question=QUESTION, sourceMode="internet"),
                "parity-check",
            ))
        finally:
            if mode != "off":
                get_settings.cache_clear()

    with pytest.MonkeyPatch.context() as mp_off:
        off_body = _run(mp_off, "off")
    with pytest.MonkeyPatch.context() as mp_shadow:
        shadow_body = _run(mp_shadow, "shadow")

    def normalised(body: bytes) -> list[dict]:
        events = []
        for line in body.decode().splitlines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[len("data: "):])
            # Strip wall-clock timing fields only — these legitimately vary
            # run-to-run and are not part of the behavior-inertness contract.
            events.append({
                k: v for k, v in event.items()
                if "ms" not in k.lower() and k != "timestamp"
            })
        return events

    assert normalised(off_body) == normalised(shadow_body)


def test_diagnostic_failure_never_breaks_the_real_response(monkeypatch):
    """Any exception inside the diagnostic layer (e.g. a real DB error)
    must degrade silently — the student's answer is unaffected."""
    from app.config import get_settings
    from app.services import diagnostic_policy

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)

        def _boom(**_kwargs):
            raise RuntimeError("simulated diagnostic failure")

        monkeypatch.setattr(diagnostic_policy, "compile_diagnostic_policy", _boom)

        warned = []
        monkeypatch.setattr(router.log, "warning", lambda *a, **_k: warned.append(a))

        body = asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(courseId="", question=QUESTION, sourceMode="internet"),
            "diagnostic-failure-case",
        ))
        assert b'"code": "internal_error"' not in body
        assert b'"done": true' in body
        assert any("semantic_intent_diagnostic_policy_failed" in str(a[0]) for a in warned)
    finally:
        get_settings.cache_clear()


def test_diagnostic_wiring_never_logs_the_raw_question(monkeypatch):
    """to_diagnostic_record only ever carries counts/enums/hashes — this
    proves the actual log call at the route boundary stays that way too."""
    from app.config import get_settings

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)

        logged = []
        monkeypatch.setattr(router.log, "info", lambda *a, **_k: logged.append(a))

        asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(courseId="", question=QUESTION, sourceMode="internet"),
            "diagnostic-no-raw-logging",
        ))

        for entry in logged:
            assert QUESTION not in " ".join(str(part) for part in entry)
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Performance-correction regression tests (decoupling from the critical
# path + bounded background concurrency). See
# _schedule_semantic_intent_diagnostic_policy / _run_semantic_intent_
# diagnostic_policy's docstrings in app/routers/stream.py for the
# production Hetzner measurement that motivated this.
# ---------------------------------------------------------------------------

def test_background_diagnostic_still_records_after_response_returns(monkeypatch):
    """The diagnostic is scheduled, not awaited. Prove it still produces
    its log line once it finishes, even though the response has already
    returned by the time we check for it."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_: None)
        monkeypatch.setattr(conversation_store, "append_tutor_commentary", lambda **_: None)
        monkeypatch.setattr(conversation_store, "validate_durable_conversation", lambda **_: True)

        def _slowish_get_messages(**_kwargs):
            time.sleep(0.02)
            return []

        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", _slowish_get_messages,
        )

        logged = []
        monkeypatch.setattr(router.log, "info", lambda *a, **_k: logged.append(a))

        async def _run():
            body = await _consume(
                router, router.AskStreamRequest(
                    courseId="", question=QUESTION, sourceMode="internet",
                    durableConversation=True, conversationId="00000000-0000-4000-8000-00000000d777",
                    clientMessageId="client-bg", assistantMessageId="assistant-bg",
                ),
                "diagnostic-background-record",
            )
            # The response just returned; the background task may well
            # still be running. Only now do we wait for it.
            pending = list(router._semantic_intent_diagnostic_tasks)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            return body

        body = asyncio.run(_run())
        assert b'"done": true' in body
        diagnostic_logs = [a for a in logged if a and "semantic_intent_diagnostic_policy" in str(a[0])]
        assert diagnostic_logs, "the background diagnostic must still log its result once it finishes"
        assert diagnostic_logs[0][2] == "durable_store"
    finally:
        get_settings.cache_clear()


def test_repeated_slow_requests_do_not_create_uncontrolled_background_work(monkeypatch):
    """Firing more concurrent durable-conversation requests than
    _SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT allows must never grow the
    tracked background-task set past that bound, and the excess requests'
    diagnostics must be skipped (logged), not queued -- while every
    request's actual SSE response still completes normally regardless."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_: None)
        monkeypatch.setattr(conversation_store, "append_tutor_commentary", lambda **_: None)
        monkeypatch.setattr(conversation_store, "validate_durable_conversation", lambda **_: True)

        peak_inflight = 0

        def _slow_get_messages(**_kwargs):
            nonlocal peak_inflight
            peak_inflight = max(peak_inflight, len(router._semantic_intent_diagnostic_tasks))
            time.sleep(0.1)
            return []

        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", _slow_get_messages,
        )

        warned = []
        monkeypatch.setattr(router.log, "warning", lambda *a, **_k: warned.append(a))

        n_requests = router._SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT + 4

        async def _run():
            bodies = await asyncio.gather(*[
                _consume(
                    router, router.AskStreamRequest(
                        courseId="", question=QUESTION, sourceMode="internet",
                        durableConversation=True,
                        conversationId=f"00000000-0000-4000-8000-00000000e{i:03d}",
                        clientMessageId=f"client-burst-{i}", assistantMessageId=f"assistant-burst-{i}",
                    ),
                    f"diagnostic-burst-{i}",
                )
                for i in range(n_requests)
            ])
            pending = list(router._semantic_intent_diagnostic_tasks)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            return bodies

        bodies = asyncio.run(_run())

        for body in bodies:
            assert b'"done": true' in body, "every request's real response must complete regardless of capacity"

        assert peak_inflight <= router._SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT, (
            f"peak in-flight diagnostics ({peak_inflight}) exceeded the configured bound "
            f"({router._SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT})"
        )
        assert len(router._semantic_intent_diagnostic_tasks) == 0, "all tasks must be cleaned up once finished"

        skipped = [a for a in warned if "semantic_intent_diagnostic_policy_skipped_capacity" in str(a[0])]
        assert skipped, "at least one request past the bound must have its diagnostic skipped, not queued"
        for entry in skipped:
            assert QUESTION not in " ".join(str(p) for p in entry), "skipped-capacity log must stay privacy-safe too"
    finally:
        get_settings.cache_clear()


def test_diagnostic_capacity_exhausted_is_skipped_not_queued(monkeypatch):
    """Direct, precise check of the bound itself: once
    _SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT tasks are tracked as
    in-flight, scheduling one more must not create a new task at all."""
    from app.config import get_settings

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)

        warned = []
        monkeypatch.setattr(router.log, "warning", lambda *a, **_k: warned.append(a))

        async def _run():
            blockers = [asyncio.Event() for _ in range(router._SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT)]

            async def _blocked(event):
                await event.wait()

            filler_tasks = [asyncio.create_task(_blocked(e)) for e in blockers]
            for t in filler_tasks:
                router._semantic_intent_diagnostic_tasks.add(t)
                t.add_done_callback(router._semantic_intent_diagnostic_tasks.discard)

            before = set(router._semantic_intent_diagnostic_tasks)
            assert len(before) == router._SEMANTIC_INTENT_DIAGNOSTIC_MAX_CONCURRENT

            router._schedule_semantic_intent_diagnostic_policy(
                question=QUESTION, dialogue=object(), computed_intent=None,
                user_id="00000000-0000-4000-8000-000000000099",
                conversation_id="00000000-0000-4000-8000-00000000d555",
                has_unverified_context=False, mode="shadow",
            )
            after = set(router._semantic_intent_diagnostic_tasks)
            assert after == before, "capacity exhausted must not create a new task"

            for e in blockers:
                e.set()
            await asyncio.gather(*filler_tasks, return_exceptions=True)

        asyncio.run(_run())

        assert any("semantic_intent_diagnostic_policy_skipped_capacity" in str(a[0]) for a in warned)
    finally:
        get_settings.cache_clear()


def test_cancelled_diagnostic_task_is_cleaned_up_without_error(monkeypatch):
    """Simulates graceful shutdown: a still-running diagnostic task gets
    cancelled rather than awaited to completion. This must not raise, must
    not log a spurious "unhandled exception" warning (CancelledError here
    is expected, not a failure), and must still be removed from the
    tracked task set."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(conversation_store, "validate_durable_conversation", lambda **_: True)

        def _slow_get_messages(**_kwargs):
            time.sleep(0.3)
            return []

        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", _slow_get_messages,
        )

        warned = []
        monkeypatch.setattr(router.log, "warning", lambda *a, **_k: warned.append(a))

        async def _run():
            router._schedule_semantic_intent_diagnostic_policy(
                question=QUESTION, dialogue=object(), computed_intent=None,
                user_id="00000000-0000-4000-8000-000000000099",
                conversation_id="00000000-0000-4000-8000-00000000d888",
                has_unverified_context=False, mode="shadow",
            )
            assert len(router._semantic_intent_diagnostic_tasks) == 1
            task = next(iter(router._semantic_intent_diagnostic_tasks))
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert len(router._semantic_intent_diagnostic_tasks) == 0, (
                "the done callback must clean up the set even for a cancelled task"
            )

        asyncio.run(_run())

        assert not any("unhandled_exception" in str(a[0]) for a in warned), (
            "a deliberate cancellation must never be logged as an unhandled task failure"
        )
    finally:
        get_settings.cache_clear()


def test_concurrent_diagnostics_do_not_cross_conversation_contaminate(monkeypatch):
    """Two concurrent durable-conversation diagnostics for two different
    conversations must each query only their own conversation, exactly
    once -- no shared mutable state between background tasks mixes up
    which conversation_id a given task is working on."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "shadow")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_: None)
        monkeypatch.setattr(conversation_store, "append_tutor_commentary", lambda **_: None)

        calls = []

        def fake_validate(*, user_id, conversation_id):
            calls.append(("validate", conversation_id))
            return True

        def fake_get_messages(*, user_id, conversation_id):
            calls.append(("get_messages", conversation_id))
            return []

        monkeypatch.setattr(conversation_store, "validate_durable_conversation", fake_validate)
        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", fake_get_messages,
        )

        conv_a = "00000000-0000-4000-8000-00000000c001"
        conv_b = "00000000-0000-4000-8000-00000000c002"

        async def _run():
            bodies = await asyncio.gather(
                _consume(
                    router, router.AskStreamRequest(
                        courseId="", question=QUESTION, sourceMode="internet",
                        durableConversation=True, conversationId=conv_a,
                        clientMessageId="client-a", assistantMessageId="assistant-a",
                    ),
                    "diagnostic-cross-conv-a",
                ),
                _consume(
                    router, router.AskStreamRequest(
                        courseId="", question=QUESTION, sourceMode="internet",
                        durableConversation=True, conversationId=conv_b,
                        clientMessageId="client-b", assistantMessageId="assistant-b",
                    ),
                    "diagnostic-cross-conv-b",
                ),
            )
            pending = list(router._semantic_intent_diagnostic_tasks)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            return bodies

        bodies = asyncio.run(_run())
        for body in bodies:
            assert b'"done": true' in body

        assert calls.count(("validate", conv_a)) == 1
        assert calls.count(("validate", conv_b)) == 1
        assert calls.count(("get_messages", conv_a)) == 1
        assert calls.count(("get_messages", conv_b)) == 1
    finally:
        get_settings.cache_clear()


def test_enabled_mode_diagnostic_still_scheduled_and_non_authoritative(monkeypatch):
    """ENABLED must behave the same as SHADOW for this observational
    layer: the diagnostic is still scheduled as a background task, never
    awaited, and its result is still discarded."""
    from app.config import get_settings
    from app.services import conversation_store

    monkeypatch.setenv("SEMANTIC_INTENT_MODE", "enabled")
    get_settings.cache_clear()
    try:
        router = _setup(monkeypatch)
        monkeypatch.setattr(conversation_store, "update_tutor_request", lambda **_: None)
        monkeypatch.setattr(conversation_store, "append_tutor_commentary", lambda **_: None)
        monkeypatch.setattr(conversation_store, "validate_durable_conversation", lambda **_: True)
        monkeypatch.setattr(
            conversation_store, "get_durable_conversation_messages_for_diagnostics", lambda **_: [],
        )

        logged = []
        monkeypatch.setattr(router.log, "info", lambda *a, **_k: logged.append(a))

        body = asyncio.run(_consume_and_drain(
            router, router.AskStreamRequest(
                courseId="", question=QUESTION, sourceMode="internet",
                durableConversation=True, conversationId="00000000-0000-4000-8000-00000000d666",
                clientMessageId="client-enabled", assistantMessageId="assistant-enabled",
            ),
            "diagnostic-enabled-mode",
        ))
        assert b'"done": true' in body

        diagnostic_logs = [a for a in logged if a and "semantic_intent_diagnostic_policy" in str(a[0])]
        assert diagnostic_logs, "ENABLED mode must still schedule and eventually log the diagnostic"
        assert diagnostic_logs[0][1] == "enabled"
    finally:
        get_settings.cache_clear()

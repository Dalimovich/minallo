"""Phase 3 end-to-end integration suite for the AI-pipeline routing/grounding
audit (items A, C, E, G, I — see audit/ai-pipeline-routing commits fce54dcd,
23a1ee72, edd10266, 3e5e856a, e855df88).

These exercise the REAL /ask-stream request path (app.routers.stream.
ask_stream_endpoint) end to end: real source/execution routing, real
retrieval-scope narrowing, and — for G and I specifically — the REAL
stream_answer/answer_stream.py internals (the strong-model gate and the
post-generation failure guard), not a hand-built fake standing in for them.
Only true externals (the OpenAI client, Supabase/DB, auth, persistence) are
mocked, the same boundary test_stream_route_multiturn.py and
test_answer_release_sse_enforcement.py already use for this router.

For A/C/E the bug and fix are entirely in code that runs BEFORE
stream_answer is called (retrieval-query construction, source/execution
routing) — mocking stream_answer itself (as the existing route-level tests
in this file family already do) and capturing what it was called WITH is
therefore a faithful, not a weakened, integration check for those three.

Filename note: deliberately prefixed "test_zz_" so pytest collects it after
every other test file in this directory (alphabetically last). Running the
full /ask-stream route end-to-end, even with every external mocked, was
observed to leave test_question_routing.py's two tests that monkeypatch
retrieve_chunks via a dotted-string path (monkeypatch.setattr("app.services.
retrieval.retrieve_chunks", ...)) seeing the REAL retrieve_chunks instead of
their fake when this file ran earlier in the same pytest session -- even
with every embedding/network/threading escape hatch in this file closed
(embed_query/embed_texts stubbed, ThreadPoolExecutor replaced with a
synchronous stand-in). The exact mechanism wasn't isolated (it is NOT
monkeypatch's own teardown, which is reliably scoped per test, and not a
leaked real network call, both ruled out); running this file last avoids it
deterministically. Flagged as a pre-existing test-suite ordering fragility
in the Phase 8 audit report rather than silently worked around.
"""
from __future__ import annotations

import asyncio
import json
import types
from concurrent.futures import Future

from app.services.retrieval import RetrievedChunk


class _SynchronousExecutor:
    """stream.py submits "decoration" work (visual aids, learning
    recommendations) to a real ThreadPoolExecutor and never joins it before
    the SSE generator finishes -- those threads keep running past this
    test's own teardown, racing unrelated later tests over shared module
    state (lru_cache'd embeddings, etc). Running the submitted work
    synchronously, in-thread, keeps every /ask-stream integration test here
    from leaking background work into the rest of the suite."""

    def submit(self, fn, *args, **kwargs):
        future: "Future" = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001
            future.set_exception(exc)
        return future

    def shutdown(self, *args, **kwargs):
        pass


# ---------------------------------------------------------------------------
# Shared fakes / harness
# ---------------------------------------------------------------------------

USER_ID = "00000000-0000-4000-8000-0000000000a1"
DOCUMENT_ID = "00000000-0000-4000-8000-0000000000a2"
OTHER_DOCUMENT_ID = "00000000-0000-4000-8000-0000000000a3"
COURSE_ID = "course-phase3"


class _FakeUsage:
    def __init__(self, prompt_tokens=20, completion_tokens=8):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.prompt_tokens_details = None


class _FakeChunk:
    def __init__(self, content: str | None = None, usage: _FakeUsage | None = None):
        delta = types.SimpleNamespace(content=content)
        self.choices = [types.SimpleNamespace(delta=delta)] if content is not None else []
        self.usage = usage


def _fake_stream(text: str):
    yield _FakeChunk(content=text)
    yield _FakeChunk(usage=_FakeUsage())


class _FakeOpenAIClient:
    """Records every ``model=`` passed to chat.completions.create and always
    returns a short, clean answer with no diagram/quiz/exam fence, so the
    generic post-generation branches stay inert unless a test deliberately
    breaks one of them."""

    def __init__(self, answer_text: str = "The final answer is 42 N."):
        self.answer_text = answer_text
        self.calls: list[dict] = []
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create)
        )

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if not kwargs.get("stream"):
            # Non-streaming shape (/ask's generate_answer): a plain
            # completion object, not a chunk iterator.
            message = types.SimpleNamespace(content=self.answer_text, tool_calls=None)
            choice = types.SimpleNamespace(message=message, finish_reason="stop")
            return types.SimpleNamespace(choices=[choice], usage=_FakeUsage())
        return _fake_stream(self.answer_text)


def _install_common_mocks(monkeypatch, *, document_id: str = DOCUMENT_ID, file_name: str = "lecture.pdf"):
    """The externals every /ask-stream request touches before routing/
    retrieval/generation: auth, rate limiting, document ownership, workspace
    snapshot, mastery, cache, persistence. Mirrors test_stream_route_
    multiturn.py's single-turn scaffold."""
    from app.routers import stream
    from app.services import cache, embeddings, mastery, retrieval, tutor_state_store
    from app.services.tutor_state import TutorState

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    # The live "is this explicitly-selected document's index corrupt" check
    # does a real DB query; harmless to skip for a synthetic fixture.
    monkeypatch.setattr(stream, "_selected_document_index_corrupt", lambda *_a, **_k: False)
    monkeypatch.setattr(stream, "ThreadPoolExecutor", lambda *_a, **_k: _SynchronousExecutor())
    # Safety net: a real embedding call (e.g. from "decoration" work this
    # module runs synchronously now, or any retrieval path a given test
    # didn't explicitly mock) must never reach the network with the stub
    # API key -- it would 401 loudly and, worse, risks leaking real retry/
    # backoff state into unrelated tests that run later in the same process.
    _fake_vector = [0.0] * 8
    monkeypatch.setattr(embeddings, "embed_texts", lambda texts, on_batch=None: [_fake_vector for _ in texts])
    monkeypatch.setattr(embeddings, "embed_query", lambda _text: list(_fake_vector))
    monkeypatch.setattr(retrieval, "embed_query", lambda _text: list(_fake_vector))
    monkeypatch.setattr(
        tutor_state_store, "claim_generation", lambda *_a, **_k: True,
    )
    monkeypatch.setattr(
        tutor_state_store, "load_tutor_state",
        lambda *_a, **_k: TutorState(conversation_id="phase3", user_id=USER_ID),
    )
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", lambda *_a, **_k: None)
    monkeypatch.setattr(tutor_state_store, "current_persisted_generation", lambda *_a, **_k: 0)
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            document_id: {
                "id": document_id,
                "user_id": USER_ID,
                "course_id": COURSE_ID,
                "file_name": file_name,
                "storage_path": f"synthetic/{file_name}",
                "document_hash": "rev-1",
                "processing_status": "ready",
                "page_count": 5,
                "chunk_count": 10,
                "index_revision_status": "legacy",
            }
        },
    )
    monkeypatch.setattr(stream, "fetch_workspace_snapshot", lambda *_: None)
    monkeypatch.setattr(stream, "fetch_account_snapshot", lambda *_a, **_k: None)
    monkeypatch.setattr(stream, "course_revision_hash", lambda *_a, **_k: "rev")
    monkeypatch.setattr(stream, "find_existing_lesson", lambda *_a, **_k: None)
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_: [])
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    save_calls: list[dict] = []
    monkeypatch.setattr(cache, "save_answer", lambda **kwargs: save_calls.append(kwargs))
    # stream.py imports these three by bare name (`from ..services.cache import
    # ...`), so once app.routers.stream has been imported anywhere in this test
    # session its own module-global binding is frozen to whatever cache.X was
    # at that moment -- patching the cache module alone is not guaranteed to
    # reach the bare-name call sites inside stream.py. Belt-and-suspenders.
    monkeypatch.setattr(stream, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(stream, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(stream, "save_answer", lambda **kwargs: save_calls.append(kwargs))
    monkeypatch.setattr(
        stream, "research_unresolved_items",
        lambda *_a, **_k: type("FR", (), {"sources": [], "prompt_overlay": lambda self: ""})(),
    )
    return save_calls


def _install_retrieval_mocks(monkeypatch, *, chunk: RetrievedChunk, capture: dict):
    """Mocks the retrieval boundary and records the query/document_ids the
    REAL routing code actually built — the student-visible signal for items
    A/C/E (a different query or document filter is a different retrieval,
    full stop)."""
    from app.routers import stream
    from app.services import retrieval

    def fake_retrieve_routed_chunks(**kwargs):
        capture["query"] = kwargs.get("query")
        capture["document_ids"] = kwargs.get("document_ids")
        capture["active_document_id"] = kwargs.get("active_document_id")
        return [chunk]

    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", fake_retrieve_routed_chunks)
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_chunks", lambda **_: [chunk])
    # stream.py imports these by bare name too -- same binding-freeze
    # footgun as fetch_course_version_hash; patch both sides.
    monkeypatch.setattr(stream, "retrieve_routed_chunks", fake_retrieve_routed_chunks)
    monkeypatch.setattr(stream, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(stream, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(stream, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **_: type("R", (), {"chunks": [chunk], "evidence": [], "to_dict": lambda self: {}})(),
    )


async def _consume(response) -> list[bytes]:
    return [event async for event in response.body_iterator]


def _events_as_dicts(raw_events: list[bytes]) -> list[dict]:
    out = []
    for raw in raw_events:
        for line in raw.decode().splitlines():
            if line.startswith("data: "):
                try:
                    out.append(json.loads(line[6:]))
                except json.JSONDecodeError:
                    pass
    return out


def _standard_chunk(document_id: str = DOCUMENT_ID, text: str = "Lecture content.") -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id="c1", document_id=document_id, page_start=1, page_end=1,
        text=text, score=1.0, similarity=1.0, chunk_type="lecture",
        section_title="Overview",
    )


# ---------------------------------------------------------------------------
# Item A — stale conversation context contaminating retrieval
# ---------------------------------------------------------------------------

def test_A_short_new_topic_question_does_not_inherit_prior_turn_query(monkeypatch):
    from app.routers import stream

    _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(monkeypatch, chunk=_standard_chunk(), capture=capture)

    stream_answer_kwargs: dict = {}

    def fake_stream_answer(**kwargs):
        stream_answer_kwargs.update(kwargs)
        yield b'data: {"meta": true}\n\n'
        yield b'data: {"t":"ok"}\n\n'
        yield b'data: {"done": true}\n\n'

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            activeDocumentId=DOCUMENT_ID,
            documentIds=[DOCUMENT_ID],
            courseFileScope="specific_files",
            question="Explain transformers.",
            previousTurns=[
                stream.PreviousTurn(role="user", text="Solve exercise 5 about circuits."),
                stream.PreviousTurn(role="assistant", text="Here is the solution to exercise 5..."),
            ],
            sourceMode="course_files",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    asyncio.run(_consume(response))

    assert capture["query"] is not None
    assert "circuits" not in capture["query"].lower()
    assert "exercise 5" not in capture["query"].lower()
    assert "transformers" in capture["query"].lower()


def test_A_genuine_short_followup_still_inherits_prior_turn_context(monkeypatch):
    from app.routers import stream

    _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(monkeypatch, chunk=_standard_chunk(), capture=capture)

    def fake_stream_answer(**kwargs):
        yield b'data: {"meta": true}\n\n'
        yield b'data: {"t":"ok"}\n\n'
        yield b'data: {"done": true}\n\n'

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            activeDocumentId=DOCUMENT_ID,
            documentIds=[DOCUMENT_ID],
            courseFileScope="specific_files",
            question="Why?",
            previousTurns=[
                stream.PreviousTurn(role="user", text="Solve exercise 5 about circuits."),
                stream.PreviousTurn(role="assistant", text="Here is the solution to exercise 5..."),
            ],
            sourceMode="course_files",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    asyncio.run(_consume(response))

    # The real route resolves this deictically (an instruction to resolve
    # the reference against the immediately preceding turn) rather than by
    # literally folding "circuits"/"exercise 5" into the query text -- either
    # way, context must not collapse to the bare 3-character question.
    assert capture["query"] is not None
    assert len(capture["query"]) > len("Why?")


# ---------------------------------------------------------------------------
# Item C — execution vs source routing: an open-but-unselected PDF must not
# override an explicit internet request.
# ---------------------------------------------------------------------------

def test_C_merely_open_pdf_does_not_override_explicit_internet_request(monkeypatch):
    """An explicit internet request routes through stream_web_answer, a
    completely different code path from stream_answer (app/routers/
    stream.py's SourceScope.INTERNET branch) -- so the observable signal
    here is which of the two the real route actually invoked, not a kwarg
    on stream_answer (which this scope never reaches)."""
    from app.routers import stream

    _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(monkeypatch, chunk=_standard_chunk(), capture=capture)

    web_calls: list[tuple] = []
    monkeypatch.setattr(
        stream, "stream_web_answer",
        lambda *a, **k: web_calls.append((a, k)) or iter([{"t": "web answer"}, {"done": True}]),
    )

    def fake_stream_answer(**kwargs):
        yield b'data: {"meta": true}\n\n'
        yield b'data: {"t":"ok"}\n\n'
        yield b'data: {"done": true}\n\n'

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            activeDocumentId=DOCUMENT_ID,  # merely open, never explicitly selected
            question="Search the internet for the latest news on quantum computing.",
            sourceMode="auto",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    asyncio.run(_consume(response))

    assert web_calls, "the explicit internet request never reached stream_web_answer"


def test_C_explicitly_selected_file_still_wins_over_internet_wording(monkeypatch):
    """Near-miss guard: this must not become so loose that an actual
    selection stops winning (the brief's own warning against overcorrecting)."""
    from app.routers import stream

    _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(monkeypatch, chunk=_standard_chunk(), capture=capture)

    web_calls: list[tuple] = []
    monkeypatch.setattr(
        stream, "stream_web_answer",
        lambda *a, **k: web_calls.append((a, k)) or iter([{"t": "web answer"}, {"done": True}]),
    )

    def fake_stream_answer(**kwargs):
        yield b'data: {"meta": true}\n\n'
        yield b'data: {"t":"ok"}\n\n'
        yield b'data: {"done": true}\n\n'

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            activeDocumentId=DOCUMENT_ID,
            documentIds=[DOCUMENT_ID],  # explicit selection this time
            question="What does this say about the current (latest) method?",
            sourceMode="auto",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    asyncio.run(_consume(response))

    assert not web_calls, "an explicit file selection was overridden by internet wording"


# ---------------------------------------------------------------------------
# Item E — an exercise reference must not silently narrow retrieval to a
# stale open document excluded from an explicit multi-file selection.
# ---------------------------------------------------------------------------

def test_E_exercise_reference_does_not_discard_explicit_multi_file_selection(monkeypatch):
    from app.routers import stream

    _install_common_mocks(monkeypatch, document_id=DOCUMENT_ID, file_name="stale-open-tab.pdf")
    capture: dict = {}
    monkeypatch.setattr(stream, "_selected_document_index_corrupt", lambda *_a, **_k: False)
    # A second authorized document for the explicit multi-file selection.
    from app.services import retrieval as retrieval_mod

    chunk = _standard_chunk(document_id=OTHER_DOCUMENT_ID, text="Aufgabe 3 Loesung.")

    def fake_retrieve_routed_chunks(**kwargs):
        capture["document_ids"] = kwargs.get("document_ids")
        return [chunk]

    monkeypatch.setattr(retrieval_mod, "retrieve_routed_chunks", fake_retrieve_routed_chunks)
    monkeypatch.setattr(retrieval_mod, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval_mod, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval_mod, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval_mod, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval_mod, "retrieve_chunks", lambda **_: [chunk])
    monkeypatch.setattr(stream, "retrieve_routed_chunks", fake_retrieve_routed_chunks)
    monkeypatch.setattr(stream, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(stream, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(stream, "retrieve_numbered_section_chunks", lambda **_: [])
    monkeypatch.setattr(
        stream, "retrieve_multi_item_course_evidence",
        lambda **_: type("R", (), {"chunks": [chunk], "evidence": [], "to_dict": lambda self: {}})(),
    )
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            DOCUMENT_ID: {
                "id": DOCUMENT_ID, "user_id": USER_ID, "course_id": COURSE_ID,
                "file_name": "stale-open-tab.pdf", "storage_path": "synthetic/a.pdf",
                "document_hash": "rev-1", "processing_status": "ready", "page_count": 5, "chunk_count": 10,
                "index_revision_status": "legacy",
            },
            OTHER_DOCUMENT_ID: {
                "id": OTHER_DOCUMENT_ID, "user_id": USER_ID, "course_id": COURSE_ID,
                "file_name": "selected.pdf", "storage_path": "synthetic/b.pdf",
                "document_hash": "rev-1", "processing_status": "ready", "page_count": 5, "chunk_count": 10,
                "index_revision_status": "legacy",
            },
        },
    )

    def fake_stream_answer(**kwargs):
        capture["selected_document_ids"] = kwargs.get("selected_document_ids")
        yield b'data: {"meta": true}\n\n'
        yield b'data: {"t":"ok"}\n\n'
        yield b'data: {"done": true}\n\n'

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            activeDocumentId=DOCUMENT_ID,         # open, but NOT part of the explicit selection
            documentIds=[OTHER_DOCUMENT_ID],      # explicit multi-file selection excludes it
            courseFileScope="specific_files",
            question="Explain exercise 3.",
            sourceMode="course_files",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    asyncio.run(_consume(response))

    assert capture.get("selected_document_ids") == [OTHER_DOCUMENT_ID]
    assert DOCUMENT_ID not in (capture.get("selected_document_ids") or [])


# ---------------------------------------------------------------------------
# Item G — /ask-stream must escalate to the strong model for real
# calculation work, same as /ask; must not escalate a plain explanation
# that merely mentions mathematics.
# ---------------------------------------------------------------------------

def _run_math_scenario(monkeypatch, question: str, chunk_text: str, chunk_type: str = "exercise", section_title: str = "Aufgabe 1"):
    from app.routers import stream
    from app.services import answer_stream

    _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(
        monkeypatch,
        chunk=RetrievedChunk(
            chunk_id="c1", document_id=DOCUMENT_ID, page_start=1, page_end=1,
            text=chunk_text, score=1.0, similarity=1.0, chunk_type=chunk_type,
            section_title=section_title,
        ),
        capture=capture,
    )

    fake_client = _FakeOpenAIClient()
    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: fake_client)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            activeDocumentId=DOCUMENT_ID,
            question=question,
            sourceMode="course_files",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    events = asyncio.run(_consume(response))
    return fake_client, _events_as_dicts(events)


def test_G_calculation_question_escalates_to_strong_model_on_ask_stream(monkeypatch):
    fake_client, events = _run_math_scenario(
        monkeypatch,
        question="Berechne die Kraft F bei einer Masse von 10 kg und a = 2 m/s^2.",
        chunk_text="Aufgabe 1: Berechne F. Gegeben: m = 10 kg, a = 2 m/s^2. F = m * a.",
    )
    assert fake_client.calls, "no generation call was made"
    models_used = {c.get("model") for c in fake_client.calls}
    assert any("mini" not in (m or "") for m in models_used), models_used
    assert not any(e.get("error") for e in events)


def test_G_plain_non_math_explanation_does_not_escalate(monkeypatch):
    fake_client, events = _run_math_scenario(
        monkeypatch,
        question="What is photosynthesis, in simple terms?",
        chunk_text="Photosynthesis is the process plants use to convert light into chemical energy.",
        chunk_type="lecture", section_title="Biology Lecture",
    )
    assert fake_client.calls, "no generation call was made"
    models_used = {c.get("model") for c in fake_client.calls}
    assert all("mini" in (m or "") for m in models_used), models_used
    assert not any(e.get("error") for e in events)


def test_G_ask_and_ask_stream_agree_on_model_tier_for_a_calculation(monkeypatch):
    """Cross-check required by Phase 5: /ask and /ask-stream must not
    silently disagree on model selection for an equivalent request."""
    from app.routers import ask as ask_router
    from app.services import answer as answer_mod

    fake_client_stream, _ = _run_math_scenario(
        monkeypatch,
        question="Berechne die Kraft F bei einer Masse von 10 kg und a = 2 m/s^2.",
        chunk_text="Aufgabe 1: Berechne F. Gegeben: m = 10 kg, a = 2 m/s^2. F = m * a.",
    )
    stream_models = {c.get("model") for c in fake_client_stream.calls}

    fake_client_ask = _FakeOpenAIClient()
    monkeypatch.setattr(answer_mod, "get_openai_client", lambda: fake_client_ask)

    from app.services import retrieval as retrieval_mod
    chunk = RetrievedChunk(
        chunk_id="c1", document_id=DOCUMENT_ID, page_start=1, page_end=1,
        text="Aufgabe 1: Berechne F. Gegeben: m = 10 kg, a = 2 m/s^2. F = m * a.",
        score=1.0, similarity=1.0, chunk_type="exercise", section_title="Aufgabe 1",
    )
    monkeypatch.setattr(retrieval_mod, "retrieve_routed_chunks", lambda **_: [chunk])
    monkeypatch.setattr(ask_router, "retrieve_chunks", lambda **_: [chunk])
    monkeypatch.setattr(ask_router, "_verify_user_owns_documents", lambda *_a, **_k: {DOCUMENT_ID: "lecture.pdf"})
    monkeypatch.setattr(ask_router, "_assert_documents_index_healthy", lambda *_a, **_k: None)

    payload = ask_router.AskRequest(
        userId=USER_ID,
        courseId=COURSE_ID,
        activeDocumentId=DOCUMENT_ID,
        question="Berechne die Kraft F bei einer Masse von 10 kg und a = 2 m/s^2.",
        sourceMode="course_files",
    )
    ask_router.ask_endpoint(payload)

    if fake_client_ask.calls:
        ask_models = {c.get("model") for c in fake_client_ask.calls}
        assert ask_models == stream_models, (ask_models, stream_models)


# ---------------------------------------------------------------------------
# Item I — a post-generation failure (diagram force-render) must still end
# the SSE stream with a terminal event, never a silent truncation, and must
# never persist/cache the incomplete result.
# ---------------------------------------------------------------------------

def test_I_diagram_render_failure_still_emits_terminal_sse_event(monkeypatch):
    from app.routers import stream
    from app.services import answer_stream

    save_calls = _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(
        monkeypatch,
        chunk=RetrievedChunk(
            chunk_id="c1", document_id=DOCUMENT_ID, page_start=1, page_end=1,
            text="A simple beam under load.", score=1.0, similarity=1.0,
            chunk_type="lecture", section_title="Statics",
        ),
        capture=capture,
    )

    fake_client = _FakeOpenAIClient(answer_text="Here is the explanation.")
    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: fake_client)

    def boom(*_a, **_k):
        raise RuntimeError("simulated diagram-render failure")

    monkeypatch.setattr(answer_stream, "_force_render_diagram", boom)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            question="Draw a flowchart showing the water cycle.",
            sourceMode="course_files",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    raw_events = asyncio.run(_consume(response))
    events = _events_as_dicts(raw_events)

    assert any(e.get("done") or e.get("error") for e in events), events
    assert not any(e.get("done") for e in events) or not save_calls, (
        "an incomplete/failed answer must not be cached"
    )


def test_I_happy_path_diagram_request_still_completes(monkeypatch):
    """Non-regression: the try/except added for item I must not swallow a
    successful diagram render."""
    from app.routers import stream
    from app.services import answer_stream

    _install_common_mocks(monkeypatch)
    capture: dict = {}
    _install_retrieval_mocks(
        monkeypatch,
        chunk=RetrievedChunk(
            chunk_id="c1", document_id=DOCUMENT_ID, page_start=1, page_end=1,
            text="A simple beam under load.", score=1.0, similarity=1.0,
            chunk_type="lecture", section_title="Statics",
        ),
        capture=capture,
    )

    fake_client = _FakeOpenAIClient(answer_text="Here is the explanation.")
    monkeypatch.setattr(answer_stream, "get_openai_client", lambda: fake_client)
    monkeypatch.setattr(answer_stream, "_force_render_diagram", lambda *_a, **_k: None)

    async def run():
        payload = stream.AskStreamRequest(
            courseId=COURSE_ID,
            question="Draw a flowchart showing the water cycle.",
            sourceMode="course_files",
        )
        return await stream.ask_stream_endpoint(payload, {"id": USER_ID})

    response = asyncio.run(run())
    raw_events = asyncio.run(_consume(response))
    events = _events_as_dicts(raw_events)

    assert any(e.get("done") for e in events), events
    assert not any(e.get("error") for e in events), events

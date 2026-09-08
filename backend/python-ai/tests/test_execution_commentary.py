import asyncio
import json

from app.services.execution_commentary import CommentaryEmitter, CommentaryKind, format_commentary


def test_emitter_builds_typed_sequenced_event() -> None:
    emitter = CommentaryEmitter("req-12345678")
    event = emitter.emit(
        kind=CommentaryKind.DOCUMENT_PROCESSING,
        stage="manifest_verified",
        facts={"expected_pages": 100, "secret": "must-not-leak"},
        progress={"current": 0, "total": 100, "unit": "pages"},
        replace_key="full_document_processing",
    )
    assert event["type"] == "commentary"
    assert event["eventSequence"] == 1
    assert event["eventId"] == "req-12345678:commentary:1"
    assert "100 required pages" in event["message"]
    assert "secret" not in event["facts"]


def test_incomplete_coverage_never_claims_completion() -> None:
    message = format_commentary(
        "coverage_incomplete", {"expected_pages": 100, "processed_pages": 99}
    )
    assert "incomplete" in message.casefold()
    assert "all 100" not in message.casefold()


def test_unknown_stage_cannot_invent_commentary() -> None:
    try:
        format_commentary("database_query_started", {})
    except ValueError as exc:
        assert "unsupported commentary stage" in str(exc)
    else:
        raise AssertionError("unsupported stages must fail closed")


def test_progress_rejects_unknown_units() -> None:
    event = CommentaryEmitter("req-12345678").emit(
        kind="analysis", stage="extraction_started",
        progress={"current": 2, "total": 4, "unit": "tokens"},
    )
    assert event["progress"] == {"current": 2, "total": 4}


def test_wording_reflects_resolved_document_and_exercise() -> None:
    message = format_commentary(
        "retrieval_started",
        {"document_name": "H2019.pdf", "exercise_label": "Aufgabe 7"},
    )
    assert "H2019.pdf" in message
    assert "Aufgabe 7" in message


def test_different_requests_produce_different_wording() -> None:
    solving_exercise = format_commentary(
        "retrieval_started", {"document_name": "H2019.pdf", "exercise_label": "Aufgabe 7"}
    )
    summarizing_lecture = format_commentary(
        "extraction_started", {"document_name": "Lecture 4.pdf"}
    )
    building_flashcards = format_commentary(
        "retrieval_started", {"topic_label": "rolling bearings"}
    )
    generic_fallback = format_commentary("retrieval_started", {})
    messages = {solving_exercise, summarizing_lecture, building_flashcards, generic_fallback}
    assert len(messages) == 4


def test_no_document_mentioned_when_unresolved() -> None:
    message = format_commentary("retrieval_started", {})
    assert message == (
        "I'm searching the selected course material for relevant sections and their surrounding context."
    )
    assert ".pdf" not in message.casefold()


def test_safe_facts_allows_new_contextual_labels_and_still_strips_unknown_keys() -> None:
    event = CommentaryEmitter("req-12345678").emit(
        kind=CommentaryKind.RETRIEVAL,
        stage="retrieval_started",
        facts={
            "document_name": "H2019.pdf",
            "exercise_label": "Aufgabe 7",
            "course_name": "GdK",
            "topic_label": "torsion",
            "not_a_real_fact": "must-not-leak",
        },
    )
    assert event["facts"] == {
        "document_name": "H2019.pdf",
        "exercise_label": "Aufgabe 7",
        "course_name": "GdK",
        "topic_label": "torsion",
    }


def test_live_stream_orientation_commentary_names_the_resolved_document(monkeypatch) -> None:
    """Route-level regression: a document can be resolved into commentary
    facts (`document_name`) while the rendered `message` still uses a stage
    formatter that never looks at that fact, silently falling back to the
    generic sentence. A unit test of format_commentary() alone can't catch
    this class of bug because it never exercises the real fact-building call
    site in stream.py — only a real run of the endpoint does."""
    from app.routers import stream
    from app.services import cache, mastery, retrieval, tutor_state_store
    from app.services.tutor_state import TutorState

    user_id = "00000000-0000-4000-8000-000000000009"
    document_id = "00000000-0000-4000-8000-000000000010"
    conversation_id = "commentary-regression-single-turn"

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    # Fire-and-forget debug logging reaches real Supabase and is unrelated to
    # what this test checks; stub it so the test never depends on network/DNS.
    monkeypatch.setattr(stream, "record_retrieval_debug", lambda *_a, **_k: None)
    monkeypatch.setattr(tutor_state_store, "claim_generation", lambda *_a, **_k: True)
    monkeypatch.setattr(
        tutor_state_store, "load_tutor_state",
        lambda *_a, **_k: TutorState(conversation_id=conversation_id, user_id=user_id),
    )
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", lambda *_a, **_k: None)
    monkeypatch.setattr(tutor_state_store, "current_persisted_generation", lambda *_a, **_k: 1)
    monkeypatch.setattr(
        stream, "_load_authorized_documents",
        lambda *_: {
            document_id: {
                "id": document_id, "user_id": user_id, "course_id": "course-1",
                "file_name": "Formelzettel Statik.pdf",
                "storage_path": "synthetic/formelzettel.pdf",
                "document_hash": "rev-1", "processing_status": "ready",
                "page_count": 2, "chunk_count": 5,
            }
        },
    )
    monkeypatch.setattr(stream, "fetch_workspace_snapshot", lambda *_: None)
    monkeypatch.setattr(mastery, "fetch_weak_topics", lambda *_: [])
    monkeypatch.setattr(cache, "fetch_course_version_hash", lambda *_: "course-rev")
    monkeypatch.setattr(cache, "lookup_answer", lambda **_: None)
    monkeypatch.setattr(cache, "save_answer", lambda **_: None)

    chunk = retrieval.RetrievedChunk(
        chunk_id="c1", document_id=document_id, page_start=1, page_end=1,
        text="Formula sheet contents.", score=1.0, similarity=1.0,
        chunk_type="formula", section_title="Formelzettel",
    )
    monkeypatch.setattr(retrieval, "retrieve_routed_chunks", lambda **_: [chunk])
    monkeypatch.setattr(retrieval, "retrieve_visible_page_chunks", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_exercise_block", lambda **_: None)
    monkeypatch.setattr(retrieval, "retrieve_formula_block", lambda **_: [])
    monkeypatch.setattr(retrieval, "retrieve_numbered_section_chunks", lambda **_: [])
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
        done = {"done": True, "retrievalMode": "strong", "answerMode": "explain", "sources": []}
        yield 'data: {"meta": true}\n\n'.encode()
        yield b'data: {"t":"This is formelzettel.pdf."}\n\n'
        yield f"data: {json.dumps(done)}\n\n".encode()

    monkeypatch.setattr(stream, "stream_answer", fake_stream_answer)

    async def run():
        payload = stream.AskStreamRequest(
            courseId="course-1", activeDocumentId=document_id,
            question="what's the open document and what does it contain?",
            visiblePage=1, sourceMode="course_files",
            openFileContext="[CURRENTLY VISIBLE PDF PAGE]\nFile: formelzettel.pdf\nPage: 1 of 2\n\n",
            conversationId=conversation_id, conversationGeneration=1,
        )
        response = await stream.ask_stream_endpoint(payload, {"id": user_id})
        return [event async for event in response.body_iterator]

    events = asyncio.run(run())
    commentary_events = []
    for raw in events:
        text = raw.decode("utf-8")
        if not text.startswith("data: "):
            continue
        try:
            parsed = json.loads(text[len("data: "):])
        except ValueError:
            continue
        if parsed.get("type") == "commentary":
            commentary_events.append(parsed)

    assert commentary_events, "expected at least one commentary event on a real request"
    orientation = commentary_events[0]
    assert orientation["stage"] == "request_received"
    assert orientation["facts"].get("document_name") == "Formelzettel Statik.pdf"
    # The bug this guards against: facts carried the resolved document name
    # while the formatted message still used the generic sentence because
    # the stage's formatter never read that fact.
    assert "Formelzettel Statik.pdf" in orientation["message"]


def test_live_stream_web_search_emits_real_commentary(monkeypatch) -> None:
    """Route-level regression: CommentaryKind.WEB_SEARCH and the
    web_search_started template existed but nothing ever constructed a
    CommentaryEmitter on the internet-search branch, so it silently emitted
    no commentary at all. A unit test of format_commentary() can't catch a
    missing emit call — only a real run of the endpoint proves the wiring."""
    from app.routers import stream
    from app.services import tutor_state_store
    from app.services.tutor_state import TutorState
    from app.services.web_answer import generate_web_answer  # noqa: F401

    user_id = "00000000-0000-4000-8000-000000000011"
    conversation_id = "commentary-web-search-single-turn"

    monkeypatch.setattr(stream, "require_active_subscription", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_interactive_cap", lambda *_: None)
    monkeypatch.setattr(stream, "enforce_rate_limit", lambda *_: None)
    monkeypatch.setattr(stream, "record_retrieval_debug", lambda *_a, **_k: None)
    monkeypatch.setattr(tutor_state_store, "claim_generation", lambda *_a, **_k: True)
    monkeypatch.setattr(
        tutor_state_store, "load_tutor_state",
        lambda *_a, **_k: TutorState(conversation_id=conversation_id, user_id=user_id),
    )
    monkeypatch.setattr(tutor_state_store, "save_tutor_state", lambda *_a, **_k: None)
    monkeypatch.setattr(tutor_state_store, "current_persisted_generation", lambda *_a, **_k: 1)
    monkeypatch.setattr(
        stream, "generate_web_answer",
        lambda *_a, **_k: {
            "answer": "The current chancellor is ...",
            "webSources": [{"title": "Example source", "url": "https://example.com"}],
            "model": "test-model", "promptTokens": 10, "completionTokens": 20,
        },
    )

    async def run():
        payload = stream.AskStreamRequest(
            courseId="course-1",
            question="who is the current chancellor of Germany?",
            sourceMode="internet",
            conversationId=conversation_id, conversationGeneration=1,
        )
        response = await stream.ask_stream_endpoint(payload, {"id": user_id})
        return [event async for event in response.body_iterator]

    events = asyncio.run(run())
    commentary_events = []
    for raw in events:
        text = raw.decode("utf-8")
        if not text.startswith("data: "):
            continue
        try:
            parsed = json.loads(text[len("data: "):])
        except ValueError:
            continue
        if parsed.get("type") == "commentary":
            commentary_events.append(parsed)

    web_search_events = [e for e in commentary_events if e["kind"] == "web_search"]
    assert web_search_events, "expected a real WEB_SEARCH commentary event, none were emitted"
    assert web_search_events[0]["stage"] == "web_search_started"
    assert "web sources" in web_search_events[0]["message"].casefold()


def test_full_document_progress_reports_the_real_page_range_being_processed() -> None:
    message = format_commentary("full_document_progress", {
        "expected_pages": 84, "processed_pages": 24,
        "document_name": "Lecture 4.pdf", "batch_start_page": 13, "batch_end_page": 24,
    })
    assert "13-24" in message
    assert "84" in message
    assert "Lecture 4.pdf" in message


def test_full_document_progress_never_invents_a_page_range_it_does_not_have() -> None:
    message = format_commentary("full_document_progress", {"expected_pages": 84, "processed_pages": 24})
    assert "13-24" not in message
    assert "84" in message

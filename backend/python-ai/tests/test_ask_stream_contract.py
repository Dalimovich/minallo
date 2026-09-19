from pathlib import Path

import asyncio

from fastapi import HTTPException

from app.routers.stream import AskStreamRequest


STREAM = (Path(__file__).parents[3] / "backend/python-ai/app/routers/stream.py").read_text(encoding="utf-8")


def test_ask_stream_request_accepts_durable_turn_ids():
    payload = AskStreamRequest(
        courseId="course-id",
        activeDocumentId="00000000-0000-0000-0000-000000000001",
        conversationId="conversation-id",
        durableConversation=True,
        clientMessageId="user-message-id",
        assistantMessageId="assistant-message-id",
        requestId="request-id-123",
        requestSnapshot={"sourceMode": "course_files"},
        question="Answer all Kurzfragen",
    )

    assert payload.clientMessageId == "user-message-id"
    assert payload.assistantMessageId == "assistant-message-id"
    assert payload.requestId == "request-id-123"
    assert payload.requestSnapshot == {"sourceMode": "course_files"}


def test_ask_stream_request_rejects_too_short_request_id():
    try:
        AskStreamRequest(courseId="course-id", question="test", requestId="req_")
    except ValueError:
        return
    raise AssertionError("short request ID was accepted")


def test_cached_frontend_identity_is_restored_from_durable_request():
    assert "durable_turn_identity_restored" in STREAM
    restored = STREAM.index("get_tutor_request(")
    rejected = STREAM.index('"code": "incomplete_durable_turn_identity"')
    assert restored < rejected


def test_all_three_request_id_channels_must_match():
    from app.routers import stream as stream_router

    payload = AskStreamRequest(
        courseId="course-id",
        question="Grundlagen der Umformtechnik",
        requestId="body-request-123",
    )

    async def invoke():
        return await stream_router.ask_stream_endpoint(
            payload,
            {"id": "user-id"},
            "body-request-123",
            "different-idempotency-key",
        )

    try:
        asyncio.run(invoke())
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail["code"] == "request_id_mismatch"
        return
    raise AssertionError("mismatched idempotency key was accepted")


def test_cross_page_numbered_sections_retrieve_before_identity_refusal():
    assert "retrieve_numbered_section_chunks" in STREAM
    assert "previous_turns=previous_turns_payload" in STREAM
    assert "exercise_hit, chunks, formula_hits, section_chunks = await asyncio.gather" in STREAM
    assert "chunks = section_chunks +" in STREAM
    assert "and page_bound_request\n            and (" in STREAM
    assert "Answer and explain every explicitly requested numbered subpart" in STREAM
    assert "do not replace the answers with an overview" in STREAM


def test_every_focused_response_stage_has_an_absolute_terminal_deadline():
    assert "_FOCUSED_RESPONSE_STAGE_TIMEOUT_SECONDS" in STREAM
    assert 'code="response_stage_stalled", stage="document_preparation"' in STREAM
    assert 'code="response_stage_stalled", stage="model_generation"' in STREAM
    assert "await asyncio.gather(prepared_task, return_exceptions=True)" in STREAM
    assert "await asyncio.gather(next_event_task, return_exceptions=True)" in STREAM

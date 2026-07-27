from pathlib import Path

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

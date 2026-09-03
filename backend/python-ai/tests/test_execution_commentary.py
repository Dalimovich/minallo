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

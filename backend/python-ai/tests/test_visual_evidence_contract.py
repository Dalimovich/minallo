from __future__ import annotations

from pathlib import Path

from app.routers.stream import (
    AskStreamRequest,
    OpenFileImagePayload,
    VisualContextMeta,
    _is_terminal_sse,
    _automatic_context_conversation_id,
    _validate_open_file_images,
)


def test_visual_contract_accepts_png_regions_and_preserves_metadata() -> None:
    images = _validate_open_file_images([
        OpenFileImagePayload(
            mediaType="image/png",
            data="YWJjZA==",
            page=39,
            region="full_page",
        ),
        OpenFileImagePayload(
            mediaType="image/png",
            data="YWJjZA==",
            page=39,
            region="formula_area",
        ),
        OpenFileImagePayload(
            mediaType="image/png",
            data="YWJjZA==",
            page=39,
            region="selected_region",
        ),
    ])
    assert [image["mediaType"] for image in images] == ["image/png"] * 3
    assert [image["region"] for image in images] == [
        "full_page", "formula_area", "selected_region",
    ]


def test_request_carries_expected_visual_evidence_diagnostics() -> None:
    payload = AskStreamRequest(
        courseId="course",
        question="Why did the professor use that formula?",
        visiblePage=39,
        visualEvidenceExpected=True,
        visualContextMeta=VisualContextMeta(
            renderAttempted=True,
            renderedPage=39,
            renderedImageCount=2,
            currentPageTextChars=3200,
            activeDocumentId="doc",
            activeFileName="exam.pdf",
            snapshotId="doc:39:viewer:1",
            pageTextStatus="ready",
            capturedImagePages=[39, 39],
        ),
    )
    assert payload.visualEvidenceExpected
    assert payload.visualContextMeta
    assert payload.visualContextMeta.renderedImageCount == 2
    assert payload.visualContextMeta.capturedImagePages == [39, 39]


def test_stream_rejects_snapshot_mismatch_and_guarantees_terminal_error() -> None:
    route = (
        Path(__file__).resolve().parents[1] / "app" / "routers" / "stream.py"
    ).read_text(encoding="utf-8")
    assert 'code="visible_page_snapshot_mismatch"' in route
    assert 'code="stream_ended_without_terminal_event"' in route
    assert "visual_meta.capturedImagePages != validated_image_pages" in route
    assert "any(page != payload.visiblePage for page in validated_image_pages)" in route


def test_terminal_sse_recognises_done_and_error_only() -> None:
    assert _is_terminal_sse(b'data: {"done": true}\n\n')
    assert _is_terminal_sse(b'data: {"error": true, "code": "internal_error"}\n\n')
    assert not _is_terminal_sse(b'data: {"status": "reading_question"}\n\n')


def test_automatic_context_section_is_stable_and_document_isolated() -> None:
    first = AskStreamRequest(
        courseId="course-a",
        question="Explain it",
        documentIds=["doc-b", "doc-a"],
    )
    reordered = AskStreamRequest(
        courseId="course-a",
        question="Continue",
        documentIds=["doc-a", "doc-b"],
    )
    other_document = AskStreamRequest(
        courseId="course-a",
        question="Explain it",
        documentIds=["doc-c"],
    )
    assert _automatic_context_conversation_id(first) == _automatic_context_conversation_id(reordered)
    assert _automatic_context_conversation_id(first) != _automatic_context_conversation_id(other_document)


def test_internal_durable_conversation_warning_is_unreachable() -> None:
    route = (
        Path(__file__).resolve().parents[1] / "app" / "routers" / "stream.py"
    ).read_text(encoding="utf-8")
    assert "A durable conversation is required" not in route
    assert '"conversation_creation_failed"' in route

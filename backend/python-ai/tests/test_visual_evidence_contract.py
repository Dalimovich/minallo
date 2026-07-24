from __future__ import annotations

from app.routers.stream import (
    AskStreamRequest,
    OpenFileImagePayload,
    VisualContextMeta,
    _is_terminal_sse,
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
    ])
    assert [image["mediaType"] for image in images] == ["image/png", "image/png"]
    assert [image["region"] for image in images] == ["full_page", "formula_area"]


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
        ),
    )
    assert payload.visualEvidenceExpected
    assert payload.visualContextMeta
    assert payload.visualContextMeta.renderedImageCount == 2


def test_terminal_sse_recognises_done_and_error_only() -> None:
    assert _is_terminal_sse(b'data: {"done": true}\n\n')
    assert _is_terminal_sse(b'data: {"error": true, "code": "internal_error"}\n\n')
    assert not _is_terminal_sse(b'data: {"status": "reading_question"}\n\n')

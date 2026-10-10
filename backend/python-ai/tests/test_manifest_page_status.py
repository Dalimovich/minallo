from app.services.indexing import _manifest_page_status


def test_weak_or_ambiguous_counts_as_indexed() -> None:
    """2026-08-31 incident: weak_or_ambiguous pages carry real (if imperfect)
    OCR text, not nothing — treating them as 'failed' in the manifest
    permanently blocked activation of otherwise-fine documents over a single
    low-confidence page."""
    assert _manifest_page_status("weak_or_ambiguous") == "indexed"


def test_embedded_text_and_ocr_complete_count_as_indexed() -> None:
    assert _manifest_page_status("embedded_text_reliable") == "indexed"
    assert _manifest_page_status("ocr_complete") == "indexed"


def test_pending_on_demand_ocr_still_counts_as_failed() -> None:
    """This value means OCR was never actually attempted/completed for the
    page — unlike weak_or_ambiguous, there's no confirmed real text here, so
    it must still block activation (the manifest gate's whole point)."""
    assert _manifest_page_status("pending_on_demand_ocr") == "failed"


def test_missing_or_unknown_status_counts_as_failed() -> None:
    assert _manifest_page_status(None) == "failed"
    assert _manifest_page_status("") == "failed"
    assert _manifest_page_status("some_future_status") == "failed"

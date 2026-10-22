from app.services.indexing import _manifest_page_status, _resolve_deferred_ocr_pages


def test_weak_or_ambiguous_counts_as_indexed() -> None:
    """2026-08-31 incident: weak_or_ambiguous pages carry real (if imperfect)
    OCR text, not nothing — treating them as 'failed' in the manifest
    permanently blocked activation of otherwise-fine documents over a single
    low-confidence page."""
    assert _manifest_page_status("weak_or_ambiguous") == "indexed"


def test_embedded_text_and_ocr_complete_count_as_indexed() -> None:
    assert _manifest_page_status("embedded_text_reliable") == "indexed"
    assert _manifest_page_status("ocr_complete") == "indexed"


def test_ocr_deferrable_statuses_count_as_deferred_not_failed() -> None:
    """2026-10-11 BWL incident: a page flagged pending_on_demand_ocr (deferred
    past the per-document OCR cap), skipped_probable_front_matter, or a
    literal "failed" OCR attempt must NOT block the whole document the way a
    true hard failure would — activate_document_index_revision only counts a
    literal 'failed' manifest row, so these now map to the non-blocking
    'deferred' status instead. (index_document itself promotes any of these
    to weak_or_ambiguous first whenever real pdfminer text exists — see
    _resolve_deferred_ocr_pages below — so in practice most never even reach
    this mapping with real text behind them.)"""
    assert _manifest_page_status("pending_on_demand_ocr") == "deferred"
    assert _manifest_page_status("skipped_probable_front_matter") == "deferred"
    assert _manifest_page_status("failed") == "deferred"


def test_missing_or_unknown_status_still_counts_as_failed() -> None:
    """Fail-closed default: a status this code doesn't recognize at all (not
    even in the deferrable set) must still block activation."""
    assert _manifest_page_status(None) == "failed"
    assert _manifest_page_status("") == "failed"
    assert _manifest_page_status("some_future_status") == "failed"


def _candidate(status: str, **extra) -> dict:
    return {"page_processing_status": status, "ocr_priority_score": 42.0, **extra}


def test_resolve_deferred_ocr_pages_promotes_pages_with_real_text() -> None:
    """Synthetic regression for the BWL incident shape: a document flags more
    OCR candidates than the per-document cap allows attempting. Pages beyond
    the cap that still have real pdfminer text must be promoted to
    weak_or_ambiguous (counted as indexed) and flagged for review — not left
    to block the whole document's activation."""
    real_text = "Bezugsrahmen der Unternehmensumwelt: " + ("Lorem ipsum dolor sit amet. " * 3)
    pages = {
        0: real_text,          # was pending_on_demand_ocr, has real text
        1: real_text,          # was skipped_probable_front_matter, has real text
        2: real_text,          # was a literal failed OCR attempt, has real text
    }
    page_list = [pages.get(i, "") for i in range(3)]
    ocr_page_metadata = {
        0: _candidate("pending_on_demand_ocr", ocr_needs_review=False),
        1: _candidate("skipped_probable_front_matter", ocr_needs_review=False),
        2: _candidate("failed", ocr_needs_review=True),
    }

    resolved = _resolve_deferred_ocr_pages(ocr_page_metadata, page_list)

    for idx in (0, 1, 2):
        assert resolved[idx]["page_processing_status"] == "weak_or_ambiguous"
        assert resolved[idx]["ocr_needs_review"] is True
        assert resolved[idx]["ocr_priority_score"] == 42.0  # original metadata preserved
        assert _manifest_page_status(resolved[idx]["page_processing_status"]) == "indexed"


def test_resolve_deferred_ocr_pages_leaves_genuinely_empty_pages_deferred() -> None:
    """A page with NO usable pdfminer fallback (e.g. a pure scanned image that
    missed the OCR cap) must NOT be claimed as indexed — it stays in a
    deferrable status, which the manifest reports as 'deferred' rather than
    silently 'indexed' or document-blocking 'failed'."""
    page_list = ["", "   \n\t  ", "short"]  # all under the 20-char usable-text bar
    ocr_page_metadata = {
        0: _candidate("pending_on_demand_ocr"),
        1: _candidate("skipped_probable_front_matter"),
        2: _candidate("failed"),
    }

    resolved = _resolve_deferred_ocr_pages(ocr_page_metadata, page_list)

    assert resolved[0]["page_processing_status"] == "pending_on_demand_ocr"
    assert resolved[1]["page_processing_status"] == "skipped_probable_front_matter"
    assert resolved[2]["page_processing_status"] == "failed"
    for idx in (0, 1, 2):
        assert _manifest_page_status(resolved[idx]["page_processing_status"]) == "deferred"


def test_resolve_deferred_ocr_pages_does_not_touch_already_resolved_pages() -> None:
    """Pages that already resolved to a real indexed status (ocr_complete,
    embedded_text_reliable) must pass through completely unchanged."""
    ocr_page_metadata = {
        0: _candidate("ocr_complete", ocr_confidence=0.95),
        1: _candidate("embedded_text_reliable"),
    }
    original = {k: dict(v) for k, v in ocr_page_metadata.items()}

    resolved = _resolve_deferred_ocr_pages(ocr_page_metadata, ["anything", "anything"])

    assert resolved == original

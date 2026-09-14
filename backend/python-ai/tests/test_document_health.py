from types import SimpleNamespace

from app.services import document_health as health_mod
from app.services.document_health import DocumentIndexHealth, validate_active_document_index


class _Query:
    """Chainable stub mimicking supabase-py's fluent query builder. Filters
    are ignored (as in the repo's existing fakes, e.g. test_reliability_pass.py)
    — each table's response is fixed per-test via the fake client."""

    def __init__(self, data=None, count=None):
        self._data = data
        self._count = count

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=self._data, count=self._count)


class _FakeSupabase:
    def __init__(self, *, doc_row, chunk_count, page_count, manifest_rows=None):
        self._doc_row = doc_row
        self._chunk_count = chunk_count
        self._page_count = page_count
        self._manifest_rows = manifest_rows or []

    def table(self, name: str):
        if name == "documents":
            return _Query(data=[self._doc_row] if self._doc_row else [])
        if name == "document_chunks":
            return _Query(count=self._chunk_count)
        if name == "document_pages":
            return _Query(count=self._page_count)
        if name == "document_page_manifests":
            return _Query(data=self._manifest_rows)
        raise AssertionError(f"unexpected table: {name}")


def _patch(monkeypatch, **kwargs):
    monkeypatch.setattr(health_mod, "get_supabase", lambda: _FakeSupabase(**kwargs))


def _manifest_row(page, status="indexed", required=True, reason=None):
    return {
        "page_number": page, "source_page_id": f"r1:{page}",
        "required_for_processing": required, "status": status, "exclusion_reason": reason,
    }


def test_ready_document_with_matching_live_counts_is_healthy(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-1", "processing_status": "ready", "page_count": 2, "chunk_count": 5,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=5, page_count=2,
        manifest_rows=[_manifest_row(1), _manifest_row(2)],
    )
    result = validate_active_document_index("doc-1")
    assert result["health"] == DocumentIndexHealth.READY


def test_stale_metadata_detected_when_chunk_count_lies(monkeypatch) -> None:
    """The exact production incident: processing_status='ready', chunk_count
    stored as non-zero, but document_chunks is actually empty."""
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-2", "processing_status": "ready", "page_count": 2, "chunk_count": 23,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=0, page_count=2,
        manifest_rows=[_manifest_row(1), _manifest_row(2)],
    )
    result = validate_active_document_index("doc-2")
    assert result["health"] == DocumentIndexHealth.STALE_METADATA
    assert result["actualChunkCount"] == 0
    assert result["metadataChunkCount"] == 23


def test_missing_chunks_when_metadata_also_claims_zero(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-3", "processing_status": "ready", "page_count": 0, "chunk_count": 0,
            "active_index_revision": "", "index_revision_status": "legacy",
        },
        chunk_count=0, page_count=0,
    )
    result = validate_active_document_index("doc-3")
    assert result["health"] == DocumentIndexHealth.MISSING_CHUNKS


def test_missing_pages_when_chunks_exist_without_pages(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-4", "processing_status": "ready", "page_count": 3, "chunk_count": 4,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=4, page_count=0,
        manifest_rows=[_manifest_row(1), _manifest_row(2), _manifest_row(3)],
    )
    result = validate_active_document_index("doc-4")
    assert result["health"] == DocumentIndexHealth.MISSING_PAGES


def test_manifest_invalid_when_a_page_is_marked_failed(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-5", "processing_status": "ready", "page_count": 2, "chunk_count": 4,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=4, page_count=2,
        manifest_rows=[_manifest_row(1), _manifest_row(2, status="failed")],
    )
    result = validate_active_document_index("doc-5")
    assert result["health"] == DocumentIndexHealth.MANIFEST_INVALID


def test_semantic_empty_when_every_required_page_is_non_extractable(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-6", "processing_status": "ready", "page_count": 1, "chunk_count": 0,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=0, page_count=1,
        manifest_rows=[_manifest_row(1, status="semantic_empty")],
    )
    result = validate_active_document_index("doc-6")
    assert result["health"] == DocumentIndexHealth.SEMANTIC_EMPTY


def test_revision_inconsistent_when_status_disagree(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-7", "processing_status": "ready", "page_count": 2, "chunk_count": 4,
            "active_index_revision": "r1", "index_revision_status": "building",
        },
        chunk_count=4, page_count=2,
    )
    result = validate_active_document_index("doc-7")
    assert result["health"] == DocumentIndexHealth.REVISION_INCONSISTENT


def test_in_flight_status_reports_indexing(monkeypatch) -> None:
    _patch(
        monkeypatch,
        doc_row={"id": "doc-8", "processing_status": "chunking"},
        chunk_count=0, page_count=0,
    )
    result = validate_active_document_index("doc-8")
    assert result["health"] == DocumentIndexHealth.INDEXING


def test_missing_document_reports_failed(monkeypatch) -> None:
    _patch(monkeypatch, doc_row=None, chunk_count=0, page_count=0)
    result = validate_active_document_index("nope")
    assert result["health"] == DocumentIndexHealth.FAILED
    assert result["reason"] == "document_not_found"


def test_partial_page_loss_is_not_ready(monkeypatch) -> None:
    """Reviewer-flagged gap: page_count=100, manifest itself is intact and
    complete (100 rows), but only 91 rows actually landed in document_pages —
    must not read as healthy just because 91 > 0. Isolated from the
    manifest-truncation case (which is caught earlier, by MANIFEST_INVALID)
    by keeping the manifest itself full-sized here."""
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-9", "processing_status": "ready", "page_count": 100, "chunk_count": 148,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=148, page_count=91,
        manifest_rows=[_manifest_row(n) for n in range(1, 101)],
    )
    result = validate_active_document_index("doc-9")
    assert result["health"] == DocumentIndexHealth.STALE_METADATA
    assert result["actualPageCount"] == 91
    assert result["metadataPageCount"] == 100


def test_partial_chunk_loss_is_not_ready(monkeypatch) -> None:
    """Reviewer-flagged gap: chunk_count=120 but only 74 live chunks must not
    read as healthy just because 74 > 0."""
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-10", "processing_status": "ready", "page_count": 10, "chunk_count": 120,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=74, page_count=10,
        manifest_rows=[_manifest_row(n) for n in range(1, 11)],
    )
    result = validate_active_document_index("doc-10")
    assert result["health"] == DocumentIndexHealth.STALE_METADATA
    assert result["actualChunkCount"] == 74
    assert result["metadataChunkCount"] == 120


def test_supabase_failure_maps_to_unknown_not_a_raised_exception(monkeypatch) -> None:
    """The docstring promises this never raises — including when its OWN
    Supabase calls fail (a transient blip), not just when the document's data
    is defective. A raw exception here used to crash the whole ask-stream
    endpoint (this check runs before the endpoint's own try/except exists)."""

    class _BoomSupabase:
        def table(self, _name: str):
            raise ConnectionError("simulated Supabase outage")

    monkeypatch.setattr(health_mod, "get_supabase", lambda: _BoomSupabase())
    result = validate_active_document_index("doc-boom")
    assert result["health"] == DocumentIndexHealth.UNKNOWN
    assert result["reason"] == "health_check_failed"


def test_truncated_manifest_no_longer_validates_against_itself(monkeypatch) -> None:
    """Reviewer-flagged gap: a manifest with only 93 of an expected 100 rows
    must be caught (MANIFEST_INVALID), not validated against its own count
    (physical_page_count=len(manifest_rows) would have silently passed)."""
    _patch(
        monkeypatch,
        doc_row={
            "id": "doc-11", "processing_status": "ready", "page_count": 100, "chunk_count": 148,
            "active_index_revision": "r1", "index_revision_status": "ready",
        },
        chunk_count=148, page_count=100,
        manifest_rows=[_manifest_row(n) for n in range(1, 94)],  # only 93 rows
    )
    result = validate_active_document_index("doc-11")
    assert result["health"] == DocumentIndexHealth.MANIFEST_INVALID

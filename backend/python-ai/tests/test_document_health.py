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

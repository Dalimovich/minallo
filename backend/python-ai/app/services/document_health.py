"""Live index-health check for a document's active revision.

``documents.processing_status='ready'`` plus a non-zero ``chunk_count`` are
CACHED counters written at the end of a successful index build — they are
not proof that ``document_chunks``/``document_pages`` still hold those rows
right now. A 2026-08-31 production incident found 25 documents in one course
sitting at 'ready' with a stale non-zero chunk_count while the live chunk
count was actually zero (their chunks had been deleted by a caller that
bypassed the revision-safe rebuild path). This module is the single place
that compares cached metadata against live rows, so RAG/readiness checks
never have to trust the cache alone again.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from ..supabase_client import get_supabase
from .index_manifest import validate_page_manifest

_IN_FLIGHT_STATUSES = {"extracting_text", "chunking", "embedding"}
_INCONSISTENT_REVISION_STATUSES = {"building", "failed"}


class DocumentIndexHealth(StrEnum):
    READY = "READY"
    INDEXING = "INDEXING"
    SEMANTIC_EMPTY = "SEMANTIC_EMPTY"
    STALE_METADATA = "STALE_METADATA"
    MISSING_CHUNKS = "MISSING_CHUNKS"
    MISSING_PAGES = "MISSING_PAGES"
    MANIFEST_INVALID = "MANIFEST_INVALID"
    REVISION_INCONSISTENT = "REVISION_INCONSISTENT"
    FAILED = "FAILED"


def _result(document_id: str, health: DocumentIndexHealth, reason: str | None, **extra: Any) -> dict[str, Any]:
    return {"documentId": document_id, "health": health, "reason": reason, **extra}


def validate_active_document_index(document_id: str) -> dict[str, Any]:
    """Compare ``documents`` metadata against the actual live rows for its
    ``active_index_revision``. Never raises — every defect maps to a typed
    health state instead of an unhandled exception."""
    sb = get_supabase()
    rows = (
        sb.table("documents")
        .select(
            "id, processing_status, page_count, chunk_count, "
            "active_index_revision, index_revision_status"
        )
        .eq("id", document_id).limit(1).execute()
    ).data or []
    if not rows:
        return _result(document_id, DocumentIndexHealth.FAILED, "document_not_found")

    doc = rows[0]
    status = str(doc.get("processing_status") or "").casefold()
    if status in _IN_FLIGHT_STATUSES:
        return _result(document_id, DocumentIndexHealth.INDEXING, status)
    if status != "ready":
        return _result(document_id, DocumentIndexHealth.FAILED, status or "not_indexed")

    revision = str(doc.get("active_index_revision") or "")
    revision_status = str(doc.get("index_revision_status") or "").casefold()
    if revision and revision_status in _INCONSISTENT_REVISION_STATUSES:
        return _result(
            document_id, DocumentIndexHealth.REVISION_INCONSISTENT,
            f"processing_status=ready but index_revision_status={revision_status}",
            activeRevision=revision,
        )

    metadata_pages = int(doc.get("page_count") or 0)
    metadata_chunks = int(doc.get("chunk_count") or 0)

    chunks_q = sb.table("document_chunks").select("id", count="exact", head=True).eq("document_id", document_id)
    pages_q = sb.table("document_pages").select("id", count="exact", head=True).eq("document_id", document_id)
    if revision:
        chunks_q = chunks_q.eq("index_revision", revision)
        pages_q = pages_q.eq("index_revision", revision)
    actual_chunks = chunks_q.execute().count or 0
    actual_pages = pages_q.execute().count or 0

    common = {
        "activeRevision": revision or None,
        "metadataPageCount": metadata_pages,
        "metadataChunkCount": metadata_chunks,
        "actualPageCount": actual_pages,
        "actualChunkCount": actual_chunks,
    }

    manifest_all_non_indexed = False
    if revision:
        manifest_rows = (
            sb.table("document_page_manifests")
            .select("page_number, source_page_id, required_for_processing, status, exclusion_reason")
            .eq("document_id", document_id).eq("index_revision", revision)
            .order("page_number").execute()
        ).data or []
        common["manifestPageCount"] = len(manifest_rows)
        # Validate against the AUTHORITATIVE expected page count
        # (documents.page_count, written at the same moment as this exact
        # revision's activation), never against len(manifest_rows) itself —
        # a manifest that's missing rows (e.g. 93 of an expected 100 pages)
        # must not be asked "does this manifest cover its own rows?" (always
        # yes) instead of "does it cover every expected page?" (the real
        # question). Only skip when nothing is expected at all.
        if metadata_pages > 0:
            try:
                pages = validate_page_manifest(manifest_rows, physical_page_count=metadata_pages)
            except ValueError as exc:
                return _result(document_id, DocumentIndexHealth.MANIFEST_INVALID, str(exc), **common)
            required = [p for p in pages if p.required_for_processing]
            manifest_all_non_indexed = bool(required) and all(p.status != "indexed" for p in required)

    if actual_chunks <= 0:
        if manifest_all_non_indexed:
            return _result(document_id, DocumentIndexHealth.SEMANTIC_EMPTY, "every required page is non-extractable", **common)
        if metadata_chunks > 0:
            return _result(document_id, DocumentIndexHealth.STALE_METADATA, "chunk_count>0 but no live chunks under the active revision", **common)
        return _result(document_id, DocumentIndexHealth.MISSING_CHUNKS, "no chunks under the active revision", **common)

    if actual_pages <= 0:
        return _result(document_id, DocumentIndexHealth.MISSING_PAGES, "chunks exist but no pages under the active revision", **common)

    # Partial loss: some rows exist, but not as many as expected. >0 is not
    # the invariant — exact-match to the authoritative counts is (a
    # document with page_count=100/chunk_count=148 but only 91 live pages or
    # 120 live chunks is a corrupted index, not a healthy one with "some
    # searchable rows").
    if metadata_pages and actual_pages != metadata_pages:
        return _result(
            document_id, DocumentIndexHealth.STALE_METADATA,
            f"page_count={metadata_pages} but active revision has {actual_pages} live page(s)", **common,
        )
    if metadata_chunks and actual_chunks != metadata_chunks:
        return _result(
            document_id, DocumentIndexHealth.STALE_METADATA,
            f"chunk_count={metadata_chunks} but active revision has {actual_chunks} live chunk(s)", **common,
        )

    return _result(document_id, DocumentIndexHealth.READY, None, **common)

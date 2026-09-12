"""Backfill the Document Understanding Layer for already-indexed documents.

Recomputes understanding from the stored ``document_pages.cleaned_text`` WITHOUT
re-embedding or re-downloading the PDF — so it's cheap and safe to run over an
existing corpus after migration 20260610_000004 is applied. Idempotent: by
default it only touches documents that don't yet have an understanding payload.
"""

from __future__ import annotations

import logging
from typing import Any

from .document_intelligence import analyze_document
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_SAMPLE_PAGES = 6
_SAMPLE_CHARS = 1500


def _sample_text(sb, document_id: str) -> str:
    rows = (
        sb.table("document_pages")
        .select("page_number, cleaned_text")
        .eq("document_id", document_id)
        .order("page_number")
        .limit(_SAMPLE_PAGES)
        .execute()
        .data
    ) or []
    return "\n\n".join((r.get("cleaned_text") or "")[:_SAMPLE_CHARS] for r in rows)


def _doc_topics(sb, document_id: str) -> list[str]:
    """Light proxy for the document's topics: distinct chunk section titles."""
    try:
        rows = (
            sb.table("document_chunks")
            .select("section_title")
            .eq("document_id", document_id)
            .limit(200)
            .execute()
            .data
        ) or []
    except Exception:  # noqa: BLE001
        return []
    names = {(r.get("section_title") or "").strip() for r in rows}
    return [n for n in names if n][:40]


def backfill_document(document_id: str, *, force: bool = False) -> dict[str, Any]:
    """Recompute + persist understanding for one document. Never re-embeds."""
    sb = get_supabase()
    rows = (
        sb.table("documents")
        .select("id, file_name, language, processing_status, document_understanding")
        .eq("id", document_id)
        .limit(1)
        .execute()
        .data
    ) or []
    if not rows:
        return {"documentId": document_id, "status": "not_found"}
    doc = rows[0]
    if doc.get("processing_status") != "ready":
        return {"documentId": document_id, "status": "skipped_not_ready"}
    if doc.get("document_understanding") and not force:
        return {"documentId": document_id, "status": "skipped_present"}

    sample = _sample_text(sb, document_id)
    understanding = analyze_document(
        doc.get("file_name"),
        sample,
        fallback_language=doc.get("language"),
        course_topics=_doc_topics(sb, document_id) or None,
    )
    sb.table("documents").update({
        "document_type": understanding.document_type,
        "document_type_confidence": understanding.document_type_confidence,
        "document_understanding": understanding.to_json(),
    }).eq("id", document_id).execute()
    return {
        "documentId": document_id,
        "status": "updated",
        "documentType": understanding.document_type,
        "confidence": understanding.document_type_confidence,
    }


def backfill_pending(
    *,
    user_id: str | None = None,
    course_id: str | None = None,
    limit: int = 200,
    force: bool = False,
) -> dict[str, Any]:
    """Backfill ready documents missing an understanding payload (or all, when
    ``force``). Per-document failures are isolated so one bad doc can't stop the
    batch."""
    sb = get_supabase()
    q = sb.table("documents").select("id").eq("processing_status", "ready")
    if user_id:
        q = q.eq("user_id", user_id)
    if course_id:
        q = q.eq("course_id", course_id)
    if not force:
        q = q.is_("document_understanding", "null")
    ids = [r["id"] for r in ((q.limit(limit).execute().data) or []) if r.get("id")]

    results: list[dict[str, Any]] = []
    for did in ids:
        try:
            results.append(backfill_document(did, force=force))
        except Exception:  # noqa: BLE001 — isolate per-doc failures
            log.exception("understanding backfill failed for document %s", did)
            results.append({"documentId": did, "status": "error"})
    return {
        "scanned": len(ids),
        "updated": sum(1 for r in results if r.get("status") == "updated"),
        "results": results,
    }


__all__ = ("backfill_document", "backfill_pending")

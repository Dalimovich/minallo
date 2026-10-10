"""POST /index-document and GET /document-index-status.

Both endpoints require the shared internal token. The trusted user_id
is derived by the Netlify proxy from the verified Supabase JWT — this
service never trusts a client-supplied user_id directly. Instead, the
proxy passes it in the request body, and we cross-check it against the
`documents` row's user_id to refuse any mismatch.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.indexing import IndexingError, get_index_status, run_document_indexing
from ..services.understanding_backfill import backfill_document, backfill_pending
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="",
    tags=["index"],
    dependencies=[Depends(require_internal_token)],
)


class IndexDocumentRequest(BaseModel):
    userId: str = Field(..., description="Trusted user id derived from the Supabase JWT by the proxy.")
    courseId: str
    documentId: str
    storagePath: str | None = None
    force: bool = False


class IndexDocumentResponse(BaseModel):
    documentId: str
    status: str
    pageCount: int | None = None
    chunkCount: int | None = None
    lastIndexedAt: str | None = None
    error: str | None = None


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _verify_owner(document_id: str, user_id: str) -> dict:
    """Refuse the request if the JWT-derived user_id doesn't own this document."""
    # Cheap input validation so an empty/garbage id is rejected as 400 instead
    # of crashing Postgres' UUID parser into a 500.
    if not document_id or not _UUID_RE.match(document_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="documentId must be a UUID")
    if not user_id or not _UUID_RE.match(user_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID")
    sb = get_supabase()
    result = (
        sb.table("documents")
        .select("id, user_id, course_id, storage_path")
        .eq("id", document_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    doc = rows[0]
    if doc["user_id"] != user_id:
        # 404 (not 403) on purpose — don't leak existence to other users.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    return doc


@router.post("/index-document", response_model=IndexDocumentResponse)
def index_document_endpoint(
    payload: IndexDocumentRequest,
    background: BackgroundTasks,
) -> IndexDocumentResponse:
    """Kick off indexing for a previously uploaded document.

    The actual work runs in a background task so the HTTP call returns
    immediately. The frontend polls /document-index-status to know when
    it's done.
    """
    doc = _verify_owner(payload.documentId, payload.userId)

    # Sanity: course id on the request should match the row. Reject any
    # caller that's trying to claim a doc against the wrong course.
    if doc["course_id"] != payload.courseId:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")

    def _run() -> None:
        try:
            run_document_indexing(payload.documentId, force=payload.force)
        except IndexingError:
            # Already recorded on the row by indexing.py — just log and move on.
            log.warning("indexing failed for document %s", payload.documentId)
        except Exception:  # noqa: BLE001
            log.exception("unexpected error indexing document %s", payload.documentId)

    background.add_task(_run)

    snapshot = get_index_status(payload.documentId)
    # Override the snapshot's status to 'indexing' so the frontend immediately
    # sees that work has started even before the background task touches the row.
    if snapshot.get("status") in ("not_indexed", "failed"):
        snapshot["status"] = "indexing"
    return IndexDocumentResponse(**snapshot)


@router.get("/document-index-status", response_model=IndexDocumentResponse)
def index_status_endpoint(
    documentId: str,
    userId: str,
) -> IndexDocumentResponse:
    """Poll-friendly status lookup. Same owner check as the trigger endpoint."""
    _verify_owner(documentId, userId)
    return IndexDocumentResponse(**get_index_status(documentId))


class BackfillUnderstandingRequest(BaseModel):
    userId: str | None = None
    courseId: str | None = None
    documentId: str | None = None
    limit: int = 200
    force: bool = False


@router.post("/backfill-understanding")
def backfill_understanding_endpoint(payload: BackfillUnderstandingRequest) -> dict:
    """Recompute the Document Understanding Layer from stored page text WITHOUT
    re-embedding. Either one documentId, or a batch scoped by user/course."""
    if payload.documentId:
        return backfill_document(payload.documentId, force=payload.force)
    return backfill_pending(
        user_id=payload.userId,
        course_id=payload.courseId,
        limit=max(1, min(int(payload.limit or 200), 1000)),
        force=payload.force,
    )

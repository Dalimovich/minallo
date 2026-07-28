"""OCR review + correction endpoints.

  POST /document-review-pages  → list the OCR'd pages flagged for review
  POST /correct-document-page  → save a student's correction, re-embed the doc

Both require the shared internal token and cross-check the JWT-derived
``userId`` against the ``documents`` row's owner (same pattern as
``index.py``) — the service never trusts a client-supplied user_id directly.

The correction's re-embed runs in a background task: chunking + embedding a
whole document can exceed the proxy's HTTP timeout, so the endpoint returns
immediately and the frontend re-reads the page list / chunk count afterward.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.indexing import (
    IndexingError,
    correct_document_page,
    list_review_pages,
    reindex_chunks_from_pages,
)
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="",
    tags=["corrections"],
    dependencies=[Depends(require_internal_token)],
)

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# A single corrected page is a transcription of one PDF page — generous but
# bounded so a malformed client can't push an unbounded blob into Postgres.
_MAX_CORRECTION_CHARS = 50_000


def _verify_owner(document_id: str, user_id: str) -> dict:
    """Refuse the request if the JWT-derived user_id doesn't own this document."""
    if not document_id or not _UUID_RE.match(document_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="documentId must be a UUID")
    if not user_id or not _UUID_RE.match(user_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID")
    sb = get_supabase()
    result = (
        sb.table("documents")
        .select("id, user_id, course_id")
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


class ReviewPagesRequest(BaseModel):
    userId: str = Field(..., description="Trusted user id derived from the Supabase JWT by the proxy.")
    documentId: str


class ReviewPage(BaseModel):
    pageNumber: int
    provider: str | None = None
    mode: str | None = None
    confidence: float | None = None
    unclearCount: int = 0
    text: str = ""


class ReviewPagesResponse(BaseModel):
    documentId: str
    pages: list[ReviewPage]


class CorrectPageRequest(BaseModel):
    userId: str = Field(..., description="Trusted user id derived from the Supabase JWT by the proxy.")
    courseId: str
    documentId: str
    pageNumber: int = Field(..., ge=1)
    correctedText: str


class CorrectPageResponse(BaseModel):
    documentId: str
    pageNumber: int
    status: str


@router.post("/document-review-pages", response_model=ReviewPagesResponse)
def review_pages_endpoint(payload: ReviewPagesRequest) -> ReviewPagesResponse:
    """List the OCR'd pages that still need a student's review/correction."""
    _verify_owner(payload.documentId, payload.userId)
    pages = list_review_pages(payload.documentId)
    return ReviewPagesResponse(
        documentId=payload.documentId,
        pages=[ReviewPage(**p) for p in pages],
    )


@router.post("/correct-document-page", response_model=CorrectPageResponse)
def correct_page_endpoint(
    payload: CorrectPageRequest,
    background: BackgroundTasks,
) -> CorrectPageResponse:
    """Save a student's corrected transcription for one page and re-embed.

    The page text is updated synchronously (so the next review-pages read
    reflects the fix), but the chunk re-embed runs in the background to stay
    under the proxy timeout.
    """
    doc = _verify_owner(payload.documentId, payload.userId)
    if doc["course_id"] != payload.courseId:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")

    text = payload.correctedText or ""
    if not text.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="correctedText is empty")
    if len(text) > _MAX_CORRECTION_CHARS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"correctedText exceeds {_MAX_CORRECTION_CHARS} characters",
        )

    # Write the corrected page synchronously so an immediate review-pages
    # re-read no longer lists it; this is a single fast DB update.
    try:
        correct_document_page(payload.documentId, payload.pageNumber, text)
    except IndexingError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    # Re-chunk + re-embed in the background — too slow for the proxy timeout.
    def _reindex() -> None:
        try:
            reindex_chunks_from_pages(payload.documentId)
        except IndexingError as exc:
            log.warning(
                "page correction reindex failed for %s p%s: %s",
                payload.documentId, payload.pageNumber, exc,
            )
        except Exception:  # noqa: BLE001
            log.exception(
                "unexpected error reindexing %s after correcting p%s",
                payload.documentId, payload.pageNumber,
            )

    background.add_task(_reindex)
    return CorrectPageResponse(
        documentId=payload.documentId,
        pageNumber=payload.pageNumber,
        status="accepted",
    )

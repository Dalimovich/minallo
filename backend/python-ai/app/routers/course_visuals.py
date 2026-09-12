"""Authorised access to persistent course visual thumbnails and source geometry."""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse

from ..jwt_auth import verify_supabase_jwt
from ..supabase_client import get_supabase

router = APIRouter(prefix="/course-visuals", tags=["course-visuals"])
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


def _authorised_visual(visual_id: str, user_id: str) -> dict[str, Any]:
    if not _UUID_RE.match(visual_id or ""):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="visual not found")
    sb = get_supabase()
    result = (
        sb.table("course_visuals")
        .select("id,user_id,course_id,document_id,document_revision,page_number,bounding_box,"
                "visual_type,caption,visual_description,thumbnail_path")
        .eq("id", visual_id).eq("user_id", user_id).limit(1).execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="visual not found")
    visual = rows[0]
    docs = (
        sb.table("documents").select("id,user_id,course_id,document_hash")
        .eq("id", visual["document_id"]).eq("user_id", user_id)
        .eq("course_id", visual["course_id"]).limit(1).execute()
    ).data or []
    if not docs:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="visual not found")
    if str(docs[0].get("document_hash") or "") != str(visual.get("document_revision") or ""):
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"code": "stale_visual_revision", "message": "This visual belongs to an older PDF revision."},
        )
    return visual


@router.get("/{visual_id}/thumbnail")
async def visual_thumbnail(visual_id: str, user: dict = Depends(verify_supabase_jwt)):
    visual = await run_in_threadpool(lambda: _authorised_visual(visual_id, user["id"]))
    path = str(visual.get("thumbnail_path") or "")
    if not path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="thumbnail not found")
    signed = await run_in_threadpool(
        lambda: get_supabase().storage.from_("course-visuals").create_signed_url(path, 120)
    )
    url = signed.get("signedURL") or signed.get("signedUrl") if isinstance(signed, dict) else None
    if not url:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="thumbnail unavailable")
    return RedirectResponse(str(url), status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/{visual_id}/source")
async def visual_source(visual_id: str, user: dict = Depends(verify_supabase_jwt)) -> dict[str, Any]:
    visual = await run_in_threadpool(lambda: _authorised_visual(visual_id, user["id"]))
    return {
        "visualId": visual["id"], "courseId": visual["course_id"],
        "documentId": visual["document_id"], "documentRevision": visual["document_revision"],
        "pageNumber": visual["page_number"], "boundingBox": visual["bounding_box"],
        "visualType": visual["visual_type"], "caption": visual.get("caption"),
        "description": visual.get("visual_description"),
    }


__all__ = ("router",)

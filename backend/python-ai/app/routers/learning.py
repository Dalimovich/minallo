"""Learning Agent Core endpoints (Phase 1).

  POST /course-topic-map/generate  → (re)build the per-course topic map
  POST /course-topic-map           → read the stored topic map
  POST /learning/next-action       → proactive next-best-action recommendation

All POST (the Pages proxy forwards POST only), require the shared internal
token, and cross-check the JWT-derived ``userId`` against the course's
documents — same ownership pattern as index.py / corrections.py. Building the
map can be slow on large courses, so /generate runs it in a BackgroundTask and
returns immediately; the frontend re-reads /course-topic-map afterward.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.learning_agent import (
    build_course_topic_map,
    get_course_topic_map,
    get_next_best_action,
)
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["learning"], dependencies=[Depends(require_internal_token)])

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _verify_course_owner(user_id: str, course_id: str) -> None:
    """Confirm the JWT-derived user owns at least one document in the course.

    Courses have no standalone owner row, so ownership is established via the
    user's documents (course_id is a free-form text key). Rejects requests for
    a course the user has nothing in — 404 to avoid leaking existence.
    """
    if not user_id or not _UUID_RE.match(user_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID")
    if not course_id or not isinstance(course_id, str):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="courseId is required")
    sb = get_supabase()
    res = (
        sb.table("documents")
        .select("id", count="exact", head=True)
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .execute()
    )
    if not res.count:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="course not found")


class CourseRequest(BaseModel):
    userId: str = Field(..., description="Trusted user id derived from the Supabase JWT by the proxy.")
    courseId: str


class TopicMapResponse(BaseModel):
    courseId: str
    topics: list[dict] = []
    status: str = "ok"


class NextActionResponse(BaseModel):
    courseId: str
    weakTopics: list[str] = []
    topicCount: int = 0
    actions: list[dict] = []


@router.post("/course-topic-map/generate", response_model=TopicMapResponse)
def generate_topic_map(payload: CourseRequest, background: BackgroundTasks) -> TopicMapResponse:
    """(Re)build the course topic map in the background; returns the current
    (possibly stale) map immediately so the caller can poll for the refresh."""
    _verify_course_owner(payload.userId, payload.courseId)

    def _run() -> None:
        try:
            build_course_topic_map(payload.userId, payload.courseId)
        except Exception:  # noqa: BLE001
            log.exception("topic map build failed for course %s", payload.courseId)

    background.add_task(_run)
    current = get_course_topic_map(payload.userId, payload.courseId)
    return TopicMapResponse(courseId=payload.courseId, topics=current, status="building")


@router.post("/course-topic-map", response_model=TopicMapResponse)
def read_topic_map(payload: CourseRequest) -> TopicMapResponse:
    _verify_course_owner(payload.userId, payload.courseId)
    return TopicMapResponse(
        courseId=payload.courseId,
        topics=get_course_topic_map(payload.userId, payload.courseId),
    )


@router.post("/learning/next-action", response_model=NextActionResponse)
def next_action(payload: CourseRequest) -> NextActionResponse:
    _verify_course_owner(payload.userId, payload.courseId)
    return NextActionResponse(**get_next_best_action(payload.userId, payload.courseId))

"""Study Planner router — Phase 2: AI weekly plan generation.

  POST /study-planner/generate-week  → generate or retrieve the AI weekly plan

All requests must carry the internal token header (enforced via the router's
shared dependency). Course ownership is verified via the documents table, the
same pattern used in learning.py.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.study_planner import generate_week_plan
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="",
    tags=["study-planner"],
    dependencies=[Depends(require_internal_token)],
)

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _verify_course_owner(user_id: str, course_id: str) -> None:
    """Confirm the JWT-derived user owns at least one document in the course.

    Mirrors the identical helper in learning.py. Courses have no standalone
    owner row; ownership is established via the user's documents. Returns 404
    to avoid leaking course existence.
    """
    if not user_id or not _UUID_RE.match(user_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID"
        )
    if not course_id or not isinstance(course_id, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="courseId is required"
        )
    sb = get_supabase()
    res = (
        sb.table("documents")
        .select("id", count="exact", head=True)
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .execute()
    )
    if not res.count:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="course not found"
        )


class GenerateWeekPlanRequest(BaseModel):
    userId: str = Field(
        ..., description="Trusted user id derived from the Supabase JWT by the proxy."
    )
    weekStartDate: str = Field(
        ..., description="ISO date (YYYY-MM-DD) of the Monday starting the plan week."
    )
    planScope: str = Field(
        "global_week",
        description="'global_week' plans across all courses; 'course_week' limits to courseId.",
    )
    courseId: str | None = Field(
        None,
        description="Required when planScope='course_week'. Omit for global_week.",
    )
    timezone: str = Field("UTC", description="IANA timezone name of the student.")
    dailyAvailabilityMinutes: dict[str, int] = Field(
        default_factory=dict,
        description="Map of day name (or 0-6) to available minutes. Days absent or 0 are skipped.",
    )
    regenerate: bool = Field(
        False, description="When true, bypass any cached plan and regenerate from scratch."
    )


@router.post("/study-planner/generate-week")
def generate_week(payload: GenerateWeekPlanRequest) -> dict:
    """Generate (or retrieve) the AI-powered weekly study plan.

    For course_week scope, verifies that the requesting user owns the given
    course before calling the planner. For global_week, ownership is enforced
    implicitly inside generate_week_plan (it only queries the user's own docs).

    On LLM or data failure the planner returns an empty-tasks plan — the
    TypeScript caller falls back to its deterministic algorithm in that case.
    """
    # Validate course ownership when a specific course is requested.
    if payload.courseId:
        _verify_course_owner(payload.userId, payload.courseId)

    plan_payload = {
        "userId": payload.userId,
        "weekStartDate": payload.weekStartDate,
        "planScope": payload.planScope,
        "courseId": payload.courseId,
        "timezone": payload.timezone,
        "dailyAvailabilityMinutes": payload.dailyAvailabilityMinutes,
        "regenerate": payload.regenerate,
    }

    result = generate_week_plan(plan_payload)
    return result

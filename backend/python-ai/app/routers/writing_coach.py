"""POST /writing-coach-analyse — German writing analysis for Schreibtrainer.

Spec: docs/schreibtrainer-ai-spec.md. Returns the full analysis shape
(score, strengths, corrected/improved texts, feedback items with
severity/confidence/spans, structure feedback, exam readiness,
insufficient-context block).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth import require_internal_token
from ..services.german_learner_profile import get_german_learner_profile
from ..services.writing_coach import (
    ALLOWED_LEVELS,
    ALLOWED_TASK_TYPES,
    analyse_writing,
    fetch_weakness_profile,
    persist_submission,
)

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="",
    tags=["writing-coach"],
    dependencies=[Depends(require_internal_token)],
)

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_MAX_TEXT_CHARS = 8000  # ~1500 German words; well above any sane essay submission.


class AnalyseRequest(BaseModel):
    userId: str
    text: str
    # Diagnostic only — the authenticated profile in the database decides the
    # level (see writing_coach_analyse); this is never trusted.
    profileLevel: str | None = None
    taskType: str = "freier_text"
    explanationLanguage: str = "English"


class AnalyseResponse(BaseModel):
    profileLevel: str
    taskType: str
    estimatedLevel: str
    score: dict[str, Any]
    scoreExplanation: str
    correctedText: str
    improvedText: str
    strengths: list[str]
    feedbackItems: list[dict[str, Any]]
    structureFeedback: dict[str, Any] | None = None
    examReadiness: dict[str, Any] | None = None
    practiceRecommendations: list[str]
    longitudinalNote: str | None = None
    insufficientContext: dict[str, Any] | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


@router.post("/writing-coach-analyse", response_model=AnalyseResponse)
def writing_coach_analyse(payload: AnalyseRequest) -> AnalyseResponse:
    if not payload.userId or not _UUID_RE.match(payload.userId):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="userId must be a UUID")
    # The level comes from the authenticated user's saved profile, never the
    # request: a stale tab / cached level must not grade against the wrong
    # target.
    profile = get_german_learner_profile(payload.userId)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Your profile could not be loaded right now. Please try again.",
        )
    if profile.is_learner:
        if not profile.has_target:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Choose your German exam and target level in Profile first.",
            )
        profile_level = profile.target_level
    elif payload.profileLevel in ALLOWED_LEVELS:
        # Non-learner account with no saved German target: an explicit,
        # validated request level is the only signal there is.
        profile_level = payload.profileLevel
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose your German target level in Profile first.",
        )
    if profile_level not in ALLOWED_LEVELS:
        # A saved level outside the known catalog is a data problem, not a
        # user error; grade against it as written rather than rejecting.
        log.warning("writing-coach: unrecognised saved level %r", profile_level)
    if payload.taskType not in ALLOWED_TASK_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"taskType must be one of {sorted(ALLOWED_TASK_TYPES)}",
        )

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="text is required")
    if len(text) > _MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"text is too long (max {_MAX_TEXT_CHARS} characters)",
        )

    weakness_profile = fetch_weakness_profile(payload.userId)

    analysis = analyse_writing(
        user_id=payload.userId,
        text=text,
        profile_level=profile_level,
        task_type=payload.taskType,
        explanation_language=payload.explanationLanguage or "English",
        weakness_profile=weakness_profile,
    )

    # Persistence is a no-op until the migrations land; ignore the return.
    try:
        persist_submission(
            user_id=payload.userId,
            text=text,
            profile_level=profile_level,
            task_type=payload.taskType,
            analysis=analysis,
        )
    except Exception:  # noqa: BLE001
        log.exception("writing-coach persistence failed (ignored)")

    return AnalyseResponse(**analysis)

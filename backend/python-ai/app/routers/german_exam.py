"""POST /german-exam/generate, /german-exam/results, /german-exam/weaknesses.

Shared German Exam Engine — Hören is the first module to consume this, but
nothing here is Hören-specific (see services/german_exam_*.py). Every
endpoint is internal-token gated; the browser never calls these directly —
Cloudflare functions (backend/functions/ai-german-exam-*.ts) verify the
Supabase JWT, derive the trusted userId, then forward here.

`/german-exam/weaknesses` is POST, not GET: the shared
`backend/lib/python-ai-proxy.ts::forwardToPython()` helper always issues a
POST regardless of the logical operation, and this feature deliberately does
not extend that shared proxy to support other HTTP methods for one endpoint.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.german_exam_generator import generate_task
from ..services.german_exam_performance import AttemptItem, get_weakness_snapshot, record_attempts, record_topic_used
from ..services.german_exam_profiles import GermanExamProfileError

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["german_exam"], dependencies=[Depends(require_internal_token)])


class GenerateExamTaskRequest(BaseModel):
    userId: str
    profileId: str
    module: str
    partId: str
    mode: str = "adaptive_practice"
    topic: str | None = None
    # True for prefetch/speculative generation: the learner may never see
    # this content, so the chosen topic must not be recorded as "used" here
    # — see POST /german-exam/consume, called only once the frontend
    # actually applies the result.
    speculative: bool = False


@router.post("/german-exam/generate")
def generate_exam_task_endpoint(payload: GenerateExamTaskRequest) -> dict[str, Any]:
    try:
        return generate_task(
            user_id=payload.userId,
            profile_id=payload.profileId,
            module=payload.module,
            part_id=payload.partId,
            mode=payload.mode,
            topic_override=payload.topic,
            speculative=payload.speculative,
        )
    except GermanExamProfileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except NotImplementedError as exc:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("german-exam generation failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Generation failed") from exc


class ExamResultItem(BaseModel):
    profileId: str
    profileVersion: int
    module: str
    partId: str
    taskType: str
    itemId: str
    skillTags: list[str] = Field(default_factory=list)
    difficulty: str | None = None
    attemptCount: int | None = None
    firstAttemptCorrect: bool | None = None
    finalCorrect: bool | None = None
    hintLevel: int | None = None
    replayCount: int | None = None
    transcriptRevealed: bool | None = None
    scoreValue: float | None = None
    maxScoreValue: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    generationId: str | None = None


class SubmitExamResultsRequest(BaseModel):
    userId: str
    examFamily: str
    examVariant: str | None = None
    targetLevel: str
    module: str
    items: list[ExamResultItem]


@router.post("/german-exam/results")
def submit_exam_results_endpoint(payload: SubmitExamResultsRequest) -> dict[str, Any]:
    items = [
        AttemptItem(
            profile_id=i.profileId,
            profile_version=i.profileVersion,
            module=i.module,
            part_id=i.partId,
            task_type=i.taskType,
            item_id=i.itemId,
            skill_tags=i.skillTags,
            difficulty=i.difficulty,
            attempt_count=i.attemptCount,
            first_attempt_correct=i.firstAttemptCorrect,
            final_correct=i.finalCorrect,
            hint_level=i.hintLevel,
            replay_count=i.replayCount,
            transcript_revealed=i.transcriptRevealed,
            score_value=i.scoreValue,
            max_score_value=i.maxScoreValue,
            metadata=i.metadata,
            generation_id=i.generationId,
        )
        for i in payload.items
    ]
    return record_attempts(payload.userId, payload.examFamily, payload.examVariant, payload.targetLevel, items)


class GetWeaknessSnapshotRequest(BaseModel):
    userId: str
    profileId: str
    module: str


@router.post("/german-exam/weaknesses")
def get_weakness_snapshot_endpoint(payload: GetWeaknessSnapshotRequest) -> dict[str, Any]:
    return get_weakness_snapshot(payload.userId, payload.profileId, payload.module)


class ConsumeGenerationRequest(BaseModel):
    userId: str
    profileId: str
    module: str
    partId: str
    topicId: str
    generationId: str | None = None


@router.post("/german-exam/consume")
def consume_generation_endpoint(payload: ConsumeGenerationRequest) -> dict[str, Any]:
    """Marks a previously-speculative (prefetched) generation's topic as
    actually used, now that the frontend has applied it to a real session.
    Called once, only when prefetched content is consumed — never for a
    normal (non-speculative) generate call, which already records its topic
    usage immediately inside generate_task(). generationId is the
    idempotency key (see record_topic_used()): a retried/duplicate consume
    call for the same generation is a no-op, not a second recorded use."""
    record_topic_used(payload.userId, payload.profileId, payload.module, payload.partId, payload.topicId, payload.generationId)
    return {"ok": True}

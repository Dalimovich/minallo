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
import json
from typing import Literal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services import gen_timing
from ..services.german_exam_generator import generate_task
from ..services.german_exam_performance import AttemptItem, get_weakness_snapshot, record_attempts, record_topic_used
from ..services.german_exam_profiles import GermanExamProfileError, get_part, get_profile
from ..services.german_exam_writing_grading import grade_writing_submission
from ..services import german_exam_speaking_practice as speaking_practice
from ..services.german_exam_validator import hard_issues, validate_content

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
    with gen_timing.timed_request(payload.module, payload.partId) as timer:
        try:
            result = generate_task(
                user_id=payload.userId,
                profile_id=payload.profileId,
                module=payload.module,
                part_id=payload.partId,
                mode=payload.mode,
                topic_override=payload.topic,
                speculative=payload.speculative,
            )
        except GermanExamProfileError as exc:
            gen_timing.finish(timer, "bad_request")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except NotImplementedError as exc:
            gen_timing.finish(timer, "not_implemented")
            raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, gen_timing.GenerationBudgetExceeded) or timer.expired():
                return gen_timing.failure_response(
                    timer, "budget_exceeded", status.HTTP_504_GATEWAY_TIMEOUT, "Generation took too long")
            log.exception("german-exam generation failed request_id=%s", timer.request_id)
            return gen_timing.failure_response(timer, "error", status.HTTP_502_BAD_GATEWAY, "Generation failed")
        diagnostics = gen_timing.finish(timer, "ok")
        if isinstance(result, dict):
            result["diagnostics"] = diagnostics
        return result


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


class WritingTopic(BaseModel):
    questionId: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=500)
    statements: list[str] = Field(min_length=2, max_length=2)
    communicativeSituation: str = Field(min_length=1, max_length=4000)
    taskInstructions: str = Field(min_length=1, max_length=6000)


class GradeWritingRequest(BaseModel):
    userId: str
    profileId: str
    partId: str
    topicId: str
    generationId: str | None = None
    writingCoachTaskType: str = "freier_text"
    selectedTopic: WritingTopic
    text: str = Field(min_length=1, max_length=8000)


@router.post("/german-exam/grade-writing")
def grade_writing_endpoint(payload: GradeWritingRequest) -> dict[str, Any]:
    """Grades a Schreiben submission via the shared Writing Coach evaluator
    (see german_exam_writing_grading.py) and returns a ready-to-submit
    examResultItems array — this endpoint never writes attempts itself, the
    frontend forwards that array to POST /german-exam/results exactly like
    every other module does after computing its own results client-side."""
    try:
        profile = get_profile(payload.profileId)
        part = get_part(payload.profileId, "writing", payload.partId)
    except GermanExamProfileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    text = (payload.text or "").strip()
    if payload.selectedTopic.questionId != payload.topicId:
        raise HTTPException(status_code=400, detail="selected topic does not match topicId")
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="text is required")

    try:
        return grade_writing_submission(
            user_id=payload.userId,
            profile=profile,
            part=part,
            generation_id=payload.generationId,
            writing_coach_task_type=payload.writingCoachTaskType,
            text=text,
            selected_topic=payload.selectedTopic.model_dump(),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("german-exam writing grading failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Grading failed") from exc


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


class SpeakingTurn(BaseModel):
    role: Literal["learner", "partner"]
    stage: str = Field(max_length=40)
    text: str = Field(min_length=1, max_length=10000)
    evidence: str = Field(min_length=64, max_length=64)


class SpeakingPracticeRequest(BaseModel):
    userId: str
    profileId: Literal["telc_c1_hochschule"]
    sessionId: str = Field(min_length=16, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    action: Literal["transcribe", "partner", "grade"]
    stage: str = Field(default="", max_length=40)
    audioBase64: str = Field(default="", max_length=8 * 1024 * 1024)
    mimeType: str = Field(default="audio/webm", max_length=100)
    tasks: dict[str, Any] = Field(default_factory=dict)
    selectedTopicId: str = Field(default="", max_length=80)
    turns: list[SpeakingTurn] = Field(default_factory=list, max_length=40)


@router.post("/german-exam/speaking")
def speaking_practice_endpoint(payload: SpeakingPracticeRequest) -> dict[str, Any]:
    try:
        if payload.action == "transcribe":
            return speaking_practice.transcribe(payload.userId, payload.sessionId, payload.stage, payload.audioBase64, payload.mimeType)
        if len(json.dumps(payload.tasks)) > 20000 or sum(len(t.text) for t in payload.turns) > 80000:
            raise ValueError("Speaking session is too large")
        required_parts = ["sprechen_1", "sprechen_2"] if payload.action == "grade" else ["sprechen_2" if payload.stage == "discussion" else "sprechen_1"]
        for part_id in required_parts:
            part = get_part(payload.profileId, "speaking", part_id)
            content = payload.tasks.get(part_id)
            if not isinstance(content, dict) or hard_issues(validate_content(part, content)):
                raise ValueError("Missing or malformed speaking task")
        if "sprechen_1" in required_parts and payload.selectedTopicId not in {
            q["questionId"] for q in payload.tasks["sprechen_1"]["questions"]
        }:
            raise ValueError("Choose one presentation topic")
        turns = [t.model_dump() for t in payload.turns]
        if payload.action == "partner":
            return speaking_practice.partner_turn(payload.userId, payload.sessionId, payload.stage, payload.tasks, payload.selectedTopicId, turns)
        return speaking_practice.grade_speaking(payload.userId, payload.sessionId, payload.tasks, payload.selectedTopicId, turns)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        log.exception("Speaking practice failed")
        raise HTTPException(status_code=502, detail="Speaking request failed. Please retry.") from exc

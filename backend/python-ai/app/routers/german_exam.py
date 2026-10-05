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
import random
from fractions import Fraction
from typing import Literal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services import gen_timing
from ..services.german_exam_generator import generate_task
from ..services.german_exams import build_manifest
from ..services.german_exam_performance import AttemptItem, get_weakness_snapshot, record_attempts, record_topic_used
from ..services.german_exams import GermanExamProfileError, get_part, get_profile
from ..services.german_exam_productive import validate_productive
from ..services.german_exam_writing_grading import gradable_writing_task_types, grade_writing_submission
from ..services import german_exam_speaking_practice as speaking_practice
from ..services import german_exam_testdaf_speaking as testdaf_speaking
from ..services import german_exam_dsh_grading as dsh_grading
from ..services import german_exam_dsh_practice_state as dsh_practice_state
from ..services.german_exam_dsh_generators import DshGenerationError, generate_dsh_hv_part, generate_dsh_lv_part
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


class ManifestRequest(BaseModel):
    profileId: str


@router.post("/german-exam/manifest")
def exam_manifest_endpoint(payload: ManifestRequest) -> dict[str, Any]:
    """Serializable exam structure for the profile-driven exam workspace. The
    Cloudflare function resolves profileId from the authenticated learner's saved
    profile; this endpoint only serialises the profile file."""
    try:
        return build_manifest(get_profile(payload.profileId))
    except GermanExamProfileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


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
    selectedTopic: WritingTopic | None = None
    task: dict[str, Any] | None = None
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

    # Profile/task-driven gate: the resolved part's task type must be one the
    # shared grading adapter (german_exam_writing_grading.py) is confirmed to
    # support — see GRADABLE_WRITING_PROFILE_IDS for exactly which profiles'
    # writing task types that is today (telc_c1_hochschule, testdaf_digital,
    # goethe_c1; DSH's tp_1 stays unsupported here, unchanged).
    if part.task_type not in gradable_writing_task_types():
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED,
                            detail=f"grading for task type {part.task_type!r} is not available yet")

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="text is required")
    if part.task_type == "choice_long_form_writing":
        # TELC topic-choice shape: the learner picked one of two generated topics.
        if payload.selectedTopic is None or payload.selectedTopic.questionId != payload.topicId:
            raise HTTPException(status_code=400, detail="selected topic does not match topicId")
        task_context = payload.selectedTopic.model_dump()
    else:
        # Productive-task shape (e.g. TestDaF): the single generated task is the context.
        if payload.task is None:
            raise HTTPException(status_code=400, detail="task is required for this writing task type")
        try:
            validate_productive(part, payload.task)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"invalid task: {exc}") from exc
        task_context = payload.task

    try:
        return grade_writing_submission(
            user_id=payload.userId,
            profile=profile,
            part=part,
            generation_id=payload.generationId,
            writing_coach_task_type=payload.writingCoachTaskType,
            text=text,
            selected_topic=task_context,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("german-exam writing grading failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Grading failed") from exc


class GradeSpeakingRecordingRequest(BaseModel):
    userId: str
    profileId: str
    partId: str
    task: dict[str, Any]
    audioBase64: str = Field(min_length=1, max_length=8 * 1024 * 1024)
    mimeType: str = Field(default="audio/webm", max_length=100)
    durationSeconds: float


@router.post("/german-exam/grade-speaking-recording")
def grade_speaking_recording_endpoint(payload: GradeSpeakingRecordingRequest) -> dict[str, Any]:
    """Grades a TestDaF-style independent single-recording Sprechen submission through the
    generic grade_productive()/validate_feedback() contract (SPEAKING_TYPES) — profile/task-driven
    like /grade-writing, NOT the TELC-only interactive /german-exam/speaking endpoint above, whose
    request shape (tasks/selectedTopicId/turns) is a different, incompatible protocol (see
    german_exam_testdaf_speaking.py's module docstring for why these stay two separate endpoints).
    No recording is ever stored server-side: the audio is transcribed and graded within this one
    request, then discarded."""
    try:
        part = get_part(payload.profileId, "speaking", payload.partId)
    except GermanExamProfileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if part.task_type not in testdaf_speaking.gradable_speaking_recording_task_types():
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED,
                            detail=f"speaking-recording grading for task type {part.task_type!r} is not available yet")
    try:
        validate_productive(part, payload.task)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid task: {exc}") from exc
    try:
        return testdaf_speaking.grade_testdaf_speaking_recording(
            part, payload.task, payload.audioBase64, payload.mimeType, payload.durationSeconds,
            user_id=payload.userId,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("testdaf speaking-recording grading failed")
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
    profileId: str
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
        profile = get_profile(payload.profileId)
    except GermanExamProfileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    # Profile-driven gate replacing the old profileId: Literal["telc_c1_hochschule"]
    # type hardcode: any registered profile can be named, but only a profile whose
    # structure speaking_practice.py's dispatch actually understands is accepted —
    # see GRADABLE_SPEAKING_PROFILE_IDS for exactly why TestDaF isn't in that set yet.
    if profile.profile_id not in speaking_practice.GRADABLE_SPEAKING_PROFILE_IDS:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED,
                            detail=f"speaking practice for profile {profile.profile_id!r} is not available yet")
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


# ---- DSH LV/HV practice / content-evaluation path -----------------------------------------
# Deliberately NOT /german-exam/generate + /german-exam/results: every DSH PartBlueprint stays
# available=False (dsh.py), so generate_task()'s _require_available() gate correctly refuses DSH
# forever through that path, and the normal exam-workspace navigation keeps DSH's buttons
# disabled (manifest-driven, task_types.py says every DSH task type is unimplemented). That gate
# is intentional and is NOT bypassed here: this is a separate, explicitly non-production sandbox
# for exercising the generation (german_exam_dsh_generators.py) + raw semantic grading
# (german_exam_dsh_grading.py) pipeline this session built, reachable over HTTP the same way the
# existing unit tests already call those functions directly in-process. No DSH availability flag
# is read or written by either endpoint below, and neither ever returns an official DSH score,
# a DSH-1/2/3 level, or anything scaled onto dsh.WRITTEN_MAX_POINTS — see
# german_exam_dsh_grading.py's own module docstring for why that conversion is not established.
#
# SECURE AS OF 336cc2c2's audit being resolved here: the earlier version of this comment recorded
# that the generate response exposed the full answer key via a `gradingContent` field. That is no
# longer true. Generation now writes german_exam_dsh_grading.minimal_grading_content()'s output to
# public.dsh_lv_hv_practice_generations (german_exam_dsh_practice_state.create_generation) and
# returns only the row's id as `generationId`; grading claims that row back
# (claim_generation_for_grading) by id+trusted userId, atomically, exactly once, only before
# expiry. The browser never receives requiredPoints, referenceAnswer, errorfulVariant, or
# gradingNotes for this flow — see each endpoint's own docstring below. userId on both request
# models is TRUSTED, never re-verified here: this router sits behind require_internal_token,
# reachable only from the Cloudflare Functions that already verified the caller's Supabase JWT
# (see ai-german-exam-grade-writing.ts's own pattern) — exactly the same trust boundary every
# other endpoint in this file already relies on (GenerateExamTaskRequest.userId,
# GradeWritingRequest.userId, ...), not a new one invented for DSH.

_DSH_LV_HV_PART_SPECS: dict[str, tuple[str, str, Any]] = {
    "lv": ("reading", "lv_1", generate_dsh_lv_part),
    "hv": ("listening", "hv_1", generate_dsh_hv_part),
}


def _as_number(value: Fraction) -> int | float:
    return int(value) if value.denominator == 1 else float(value)


class DshLvHvGenerateRequest(BaseModel):
    userId: str
    part: Literal["lv", "hv"]
    topic: str | None = Field(default=None, max_length=200)


@router.post("/german-exam/dsh/lv-hv/generate")
def dsh_lv_hv_generate_endpoint(payload: DshLvHvGenerateRequest) -> dict[str, Any]:
    """Generates one DSH LV or HV practice task. Returns ONLY a learner-safe `content` (every
    answer-key field — requiredPoints, optionalPoints, referenceAnswer, errorfulVariant,
    gradingNotes — stripped by dsh_grading.strip_answer_key_for_learner) plus `generationId`.
    There is no `gradingContent` in this response: the full content (minimal_grading_content's
    output — grading-essential fields only) is written server-side to
    public.dsh_lv_hv_practice_generations, owned by payload.userId, and `generationId` is that
    row's id. The browser holds an opaque reference it cannot read anything out of and cannot use
    to grade a different generation — ownership and expiry are enforced at claim time in
    dsh_lv_hv_grade_endpoint, not here."""
    module, part_id, generator = _DSH_LV_HV_PART_SPECS[payload.part]
    profile = get_profile("dsh")
    part = get_part("dsh", module, part_id)
    candidates = (profile.topic_banks or {}).get(module) or ()
    topic = (
        {"topicId": "custom", "label": payload.topic} if payload.topic
        else dict(random.choice(candidates)) if candidates
        else {"topicId": "default", "label": part.title}
    )
    try:
        content, _validation_meta = generator(profile, part, [], topic)
    except DshGenerationError as exc:
        log.exception("dsh %s practice generation failed", payload.part)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Generation failed. Please retry.") from exc
    generation_id = dsh_practice_state.create_generation(
        payload.userId, payload.part, dsh_grading.minimal_grading_content(content),
    )
    return {
        "kind": "dsh_lv_hv_practice_task",
        "part": payload.part,
        "generationId": generation_id,
        "content": dsh_grading.strip_answer_key_for_learner(content),
    }


class DshLvHvAnswer(BaseModel):
    itemId: str = Field(min_length=1, max_length=80)
    answer: str = Field(default="", max_length=8000)


class DshLvHvGradeRequest(BaseModel):
    userId: str
    part: Literal["lv", "hv"]
    generationId: str = Field(min_length=1, max_length=80)
    answers: list[DshLvHvAnswer] = Field(default_factory=list, max_length=100)
    # Deliberately no gradingContent/referenceAnswer/requiredPoints field exists on this model.
    # Pydantic's default extra="ignore" means any such key a client sends anyway is dropped
    # before this object even exists — it is never read, stored, or able to influence grading.
    # The only content grading ever uses is claimed server-side below, by generationId+userId.


@router.post("/german-exam/dsh/lv-hv/grade")
def dsh_lv_hv_grade_endpoint(payload: DshLvHvGradeRequest) -> dict[str, Any]:
    """Grades a practice LV/HV submission against SERVER-HELD grading state only — the request
    cannot supply or replace it. Claims public.dsh_lv_hv_practice_generations's row atomically
    (german_exam_dsh_practice_state.claim_generation_for_grading: ownership, expiry and one-time-
    use all enforced by a single UPDATE ... WHERE id=... AND user_id=... AND graded_at IS NULL
    AND expires_at > now() RETURNING grading_content); an unknown id, a different owner, an
    expired row, and an already-graded row are all indistinguishable 404s. The claimed content
    then reaches the existing, unchanged grader (german_exam_dsh_grading.
    grade_dsh_open_answer_part -> ContentMatcher -> score_content_item — the one authoritative
    item-scoring function; nothing here duplicates its logic). Returns a RAW, explicitly non-
    official result only: no DSH points, no percentage of any official DSH scale, no DSH-1/2/3
    level. matchedContentPointIds are computed server-side for scoring but are deliberately not
    included in this response (they would reveal, item by item, exactly which required content
    points the learner's answer did or did not satisfy)."""
    grading_content = dsh_practice_state.claim_generation_for_grading(payload.userId, payload.generationId)
    if grading_content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                             detail="Generation not found, expired, or already graded.")
    answers = {a.itemId: a.answer for a in payload.answers}
    try:
        result = dsh_grading.grade_dsh_open_answer_part(grading_content, answers)
    except dsh_grading.DshGradingError as exc:
        log.warning("dsh %s practice grading: semantic matcher failed: %s", payload.part, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                             detail="Content evaluation unavailable. Your answer was not scored.") from exc
    except Exception as exc:  # noqa: BLE001
        # Includes DshContentError: the stored grading_content should always be well-formed
        # (we wrote it), so this means a server-side data problem, never a client input problem.
        log.exception("dsh %s practice grading failed", payload.part)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                             detail="Content evaluation unavailable. Your answer was not scored.") from exc
    return {
        "kind": "dsh_lv_hv_practice_result",
        "part": payload.part,
        "generationId": payload.generationId,
        "rawPoints": _as_number(result["rawPoints"]),
        "rawMaxPoints": _as_number(result["rawMaxPoints"]),
        "percent": result["percent"],
        "items": [
            {"itemId": item["itemId"], "points": _as_number(item["points"]), "maxPoints": _as_number(item["maxPoints"])}
            for item in result["items"]
        ],
        "officialDshScore": None,
        "officialScoreAvailable": False,
    }

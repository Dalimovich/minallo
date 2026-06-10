"""POST /generate-quiz, /generate-flashcards, /generate-notes."""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.flashcards import generate_flashcards, save_flashcard_set
from ..services.notes import generate_notes, save_note
from ..services.quiz import generate_quiz, save_quiz_set
from ..services.examforge import generate_examforge, grade_examforge_answer
from ..services.cheatsheet import generate_cheatsheet
from ..services.deep_learn import generate_deep_learn
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="",
    tags=["generate"],
    dependencies=[Depends(require_internal_token)],
)

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _require_uuid(value: str, label: str) -> None:
    if not value or not _UUID_RE.match(value):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{label} must be a UUID")


def _verify_user_owns_documents(user_id: str, course_id: str, document_ids: list[str] | None) -> dict[str, str]:
    if not document_ids:
        return {}
    sb = get_supabase()
    resp = sb.table("documents").select("id, user_id, course_id, file_name").in_("id", document_ids).execute()
    rows = resp.data or []
    if len(rows) != len(document_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    for row in rows:
        if row["user_id"] != user_id or row["course_id"] != course_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    return {row["id"]: row["file_name"] for row in rows}


# Cap on how many docs "all files" expands to, so a huge course can't blow up
# retrieval. Selecting an explicit subset is never capped here (Cloudflare caps it).
_MAX_RESOLVED_DOCS = 50


def _resolve_ready_document_ids(
    user_id: str, course_id: str, document_ids: list[str] | None
) -> tuple[list[str], dict[str, str]]:
    """Resolve the set of READY documents to ground on (backend-authoritative).

    - Explicit ids: keep only those owned by the user in this course AND
      processing_status == 'ready'. Not-owned / wrong-course ids are a hard 404
      (security); ids that merely aren't indexed yet are dropped (with no error)
      so a selected-but-still-processing file can't poison the output.
    - null/empty ("all files"): return every ready doc in the course, capped, so
      "all" never silently pulls in half-indexed material.

    Returns (ready_ids, {id: file_name}).
    """
    sb = get_supabase()
    if document_ids:
        resp = (
            sb.table("documents")
            .select("id, user_id, course_id, file_name, processing_status")
            .in_("id", document_ids)
            .execute()
        )
        by_id = {r["id"]: r for r in (resp.data or [])}
        for did in document_ids:
            row = by_id.get(did)
            if row is None or row["user_id"] != user_id or row["course_id"] != course_id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
        ready = [r for r in by_id.values() if r.get("processing_status") == "ready"]
        return [r["id"] for r in ready], {r["id"]: r["file_name"] for r in ready}

    resp = (
        sb.table("documents")
        .select("id, file_name")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .eq("processing_status", "ready")
        .limit(_MAX_RESOLVED_DOCS)
        .execute()
    )
    rows = resp.data or []
    return [r["id"] for r in rows], {r["id"]: r["file_name"] for r in rows}


# ── /generate-quiz ───────────────────────────────────────────────────────────


class GenerateQuizRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    # Parallelised in quiz.py — 20 fits comfortably under Netlify's 30s.
    requestedCount: int = Field(10, ge=1, le=20)
    difficulty: str = "medium"             # easy | medium | hard | mixed
    questionTypes: list[str] | None = None  # subset of ['mcq','true_false','short_answer']
    language: str | None = None
    seenItems: list[str] | None = None      # already-seen question stems to avoid repeating
    save: bool = True
    name: str | None = None


class GenerateQuizResponse(BaseModel):
    requestedCount: int
    actualCount: int
    questions: list[dict[str, Any]]
    groundedSources: list[dict[str, Any]] = []
    warning: str | None = None
    studySetId: str | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


class GenerateExamForgeRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    requestedCount: int = Field(6, ge=1, le=20)
    difficulty: str = "medium"
    questionTypes: list[str] | None = None
    topic: str | None = None
    language: str | None = None
    save: bool = True


class GenerateExamForgeResponse(BaseModel):
    sessionId: str | None = None
    title: str
    requestedCount: int
    actualCount: int
    questions: list[dict[str, Any]]
    topicMap: list[dict[str, Any]] = []
    groundedSources: list[dict[str, Any]] = []
    warning: str | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


class GradeExamForgeAnswerRequest(BaseModel):
    userId: str
    examSessionId: str
    examQuestionId: str
    userAnswer: str


class GradeExamForgeAnswerResponse(BaseModel):
    ok: bool
    isCorrect: bool | None = None
    score: float | None = None
    correctAnswer: str | None = None
    feedback: str | None = None
    error: str | None = None


class CheatsheetSettings(BaseModel):
    # All optional; the service normalizes/clamps. Only preset + two overrides
    # are exposed (no à-la-carte matrix).
    preset: str | None = None        # exam_night | balanced | deep_revision | topic_mastery
    pages: int | None = None         # 1..4
    columns: int | None = None       # 2..4
    style: str | None = None
    fontSize: str | None = None
    detailLevel: str | None = None
    focusMode: str | None = None
    language: str | None = None
    output: str | None = None


class GenerateCheatsheetRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    topic: str | None = None
    save: bool = True
    settings: CheatsheetSettings | None = None


class GenerateCheatsheetResponse(BaseModel):
    noteId: str | None = None
    title: str | None = None
    text: str
    topicsCovered: list[str] = []
    groundedSources: list[dict[str, Any]] = []
    settings: dict[str, Any] | None = None
    grounding: dict[str, Any] | None = None
    quality: dict[str, Any] | None = None
    warning: str | None = None
    citationWarning: str | None = None
    error: str | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


class GenerateDeepLearnRequest(BaseModel):
    userId: str
    courseId: str
    topic: str
    documentIds: list[str] | None = None
    lessonMode: str | None = None
    lessonLanguage: str | None = None
    courseName: str | None = None
    studentMajor: str | None = None


class GenerateDeepLearnResponse(BaseModel):
    noteId: str | None = None
    topic: str
    title: str | None = None
    lesson: str = ""
    workedExample: str = ""
    check: dict[str, Any] | None = None
    structuredLesson: dict[str, Any] | None = None
    groundedSources: list[dict[str, Any]] = []
    citationWarning: str | None = None
    evidenceSummary: dict[str, int] = {}
    warning: str | None = None
    error: str | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


@router.post("/generate-quiz", response_model=GenerateQuizResponse)
def generate_quiz_endpoint(payload: GenerateQuizRequest) -> GenerateQuizResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    doc_names = _verify_user_owns_documents(payload.userId, payload.courseId, payload.documentIds)

    out = generate_quiz(
        user_id=payload.userId,
        course_id=payload.courseId,
        document_ids=payload.documentIds,
        requested_count=payload.requestedCount,
        difficulty=payload.difficulty,
        question_types=payload.questionTypes,
        doc_names=doc_names,
        language=payload.language,
        seen_items=payload.seenItems,
    )

    set_id: str | None = None
    if payload.save and out["questions"]:
        set_id = save_quiz_set(
            user_id=payload.userId,
            course_id=payload.courseId,
            document_ids=payload.documentIds,
            name=payload.name or "Quiz",
            difficulty=payload.difficulty,
            questions=out["questions"],
        )

    return GenerateQuizResponse(
        requestedCount=out["requestedCount"],
        actualCount=out["actualCount"],
        questions=out["questions"],
        groundedSources=out.get("groundedSources", []),
        warning=out.get("warning"),
        studySetId=set_id,
        model=out.get("model"),
        promptTokens=out.get("promptTokens"),
        completionTokens=out.get("completionTokens"),
    )


# ── /generate-examforge ──────────────────────────────────────────────────────


@router.post("/generate-examforge", response_model=GenerateExamForgeResponse)
def generate_examforge_endpoint(payload: GenerateExamForgeRequest) -> GenerateExamForgeResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    doc_names = _verify_user_owns_documents(payload.userId, payload.courseId, payload.documentIds)

    out = generate_examforge(
        user_id=payload.userId,
        course_id=payload.courseId,
        document_ids=payload.documentIds,
        requested_count=payload.requestedCount,
        difficulty=payload.difficulty,
        topic=payload.topic,
        question_types=payload.questionTypes,
        doc_names=doc_names,
        language=payload.language,
    )

    return GenerateExamForgeResponse(
        sessionId=out.get("sessionId"),
        title=out.get("title") or "ExamForge",
        requestedCount=out["requestedCount"],
        actualCount=out["actualCount"],
        questions=out["questions"],
        topicMap=out.get("topicMap", []),
        groundedSources=out.get("groundedSources", []),
        warning=out.get("warning"),
        model=out.get("model"),
        promptTokens=out.get("promptTokens"),
        completionTokens=out.get("completionTokens"),
    )


@router.post("/grade-examforge-answer", response_model=GradeExamForgeAnswerResponse)
def grade_examforge_answer_endpoint(payload: GradeExamForgeAnswerRequest) -> GradeExamForgeAnswerResponse:
    _require_uuid(payload.userId, "userId")
    _require_uuid(payload.examSessionId, "examSessionId")
    _require_uuid(payload.examQuestionId, "examQuestionId")
    out = grade_examforge_answer(
        user_id=payload.userId,
        exam_session_id=payload.examSessionId,
        exam_question_id=payload.examQuestionId,
        user_answer=payload.userAnswer,
    )
    return GradeExamForgeAnswerResponse(**out)


# ── /generate-cheatsheet ──────────────────────────────────────────────────────


@router.post("/generate-cheatsheet", response_model=GenerateCheatsheetResponse)
def generate_cheatsheet_endpoint(payload: GenerateCheatsheetRequest) -> GenerateCheatsheetResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    # Explicit selection → restrict to the ready subset (owned, same course).
    # "All files" (None) stays None so the whole-course topic-map sheet runs
    # rather than flipping into the per-PDF layout that a multi-id list triggers.
    if payload.documentIds:
        doc_ids, doc_names = _resolve_ready_document_ids(
            payload.userId, payload.courseId, payload.documentIds
        )
        if not doc_ids:
            return GenerateCheatsheetResponse(
                text="",
                warning="None of the selected files are indexed yet. Wait for indexing to finish, or pick ready files.",
            )
    else:
        doc_ids, doc_names = None, {}

    out = generate_cheatsheet(
        user_id=payload.userId,
        course_id=payload.courseId,
        document_ids=doc_ids,
        topic=payload.topic,
        doc_names=doc_names,
        save=payload.save,
        settings=payload.settings.model_dump() if payload.settings else None,
    )
    return GenerateCheatsheetResponse(
        noteId=out.get("noteId"),
        title=out.get("title"),
        text=out.get("text", ""),
        topicsCovered=out.get("topicsCovered", []),
        groundedSources=out.get("groundedSources", []),
        settings=out.get("settings"),
        grounding=out.get("grounding"),
        quality=out.get("quality"),
        warning=out.get("warning"),
        citationWarning=out.get("citationWarning"),
        error=out.get("error"),
        model=out.get("model"),
        promptTokens=out.get("promptTokens"),
        completionTokens=out.get("completionTokens"),
    )


# ── /generate-deep-learn ──────────────────────────────────────────────────────


@router.post("/generate-deep-learn", response_model=GenerateDeepLearnResponse)
def generate_deep_learn_endpoint(payload: GenerateDeepLearnRequest) -> GenerateDeepLearnResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    # Restrict to ready docs (explicit subset filtered; "all" → every ready doc).
    doc_ids, doc_names = _resolve_ready_document_ids(
        payload.userId, payload.courseId, payload.documentIds
    )
    if payload.documentIds and not doc_ids:
        return GenerateDeepLearnResponse(
            topic=payload.topic,
            title=payload.topic,
            warning="None of the selected files are indexed yet. Wait for indexing to finish, or pick ready files.",
        )

    out = generate_deep_learn(
        user_id=payload.userId,
        course_id=payload.courseId,
        topic=payload.topic,
        document_ids=doc_ids or None,
        doc_names=doc_names,
        lesson_mode=payload.lessonMode,
        lesson_language=payload.lessonLanguage,
        course_name=payload.courseName,
        student_major=payload.studentMajor,
    )
    return GenerateDeepLearnResponse(
        noteId=out.get("noteId"),
        topic=out.get("topic", payload.topic),
        title=out.get("title"),
        lesson=out.get("lesson", ""),
        workedExample=out.get("workedExample", ""),
        check=out.get("check"),
        structuredLesson=out.get("structuredLesson"),
        groundedSources=out.get("groundedSources", []),
        citationWarning=out.get("citationWarning"),
        evidenceSummary=out.get("evidenceSummary", {}),
        warning=out.get("warning"),
        error=out.get("error"),
        model=out.get("model"),
        promptTokens=out.get("promptTokens"),
        completionTokens=out.get("completionTokens"),
    )


# ── /generate-flashcards ─────────────────────────────────────────────────────


class GenerateFlashcardsRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    # Parallelised in flashcards.py — 24 fits comfortably under Netlify's 30s.
    requestedCount: int = Field(10, ge=1, le=24)
    difficulty: str = "medium"              # easy | medium | hard | mixed
    language: str | None = None
    seenItems: list[str] | None = None      # already-seen card fronts to avoid repeating
    save: bool = True
    name: str | None = None


class GenerateFlashcardsResponse(BaseModel):
    requestedCount: int
    actualCount: int
    cards: list[dict[str, Any]]
    groundedSources: list[dict[str, Any]] = []
    warning: str | None = None
    studySetId: str | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


@router.post("/generate-flashcards", response_model=GenerateFlashcardsResponse)
def generate_flashcards_endpoint(payload: GenerateFlashcardsRequest) -> GenerateFlashcardsResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    doc_names = _verify_user_owns_documents(payload.userId, payload.courseId, payload.documentIds)

    out = generate_flashcards(
        user_id=payload.userId,
        course_id=payload.courseId,
        document_ids=payload.documentIds,
        requested_count=payload.requestedCount,
        doc_names=doc_names,
        difficulty=payload.difficulty,
        language=payload.language,
        seen_items=payload.seenItems,
    )

    set_id: str | None = None
    if payload.save and out["cards"]:
        set_id = save_flashcard_set(
            user_id=payload.userId,
            course_id=payload.courseId,
            document_ids=payload.documentIds,
            name=payload.name or "Flashcards",
            cards=out["cards"],
        )

    return GenerateFlashcardsResponse(
        requestedCount=out["requestedCount"],
        actualCount=out["actualCount"],
        cards=out["cards"],
        groundedSources=out.get("groundedSources", []),
        warning=out.get("warning"),
        studySetId=set_id,
        model=out.get("model"),
        promptTokens=out.get("promptTokens"),
        completionTokens=out.get("completionTokens"),
    )


# ── /generate-notes ──────────────────────────────────────────────────────────


class GenerateNotesRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    topic: str | None = None
    title: str | None = None
    save: bool = True


class GenerateNotesResponse(BaseModel):
    text: str
    pageCount: int | None = None
    lengthCue: str | None = None
    groundedSources: list[dict[str, Any]] = []
    warning: str | None = None
    noteId: str | None = None
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


@router.post("/generate-notes", response_model=GenerateNotesResponse)
def generate_notes_endpoint(payload: GenerateNotesRequest) -> GenerateNotesResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    doc_names = _verify_user_owns_documents(payload.userId, payload.courseId, payload.documentIds)

    out = generate_notes(
        user_id=payload.userId,
        course_id=payload.courseId,
        document_ids=payload.documentIds,
        topic=payload.topic,
        doc_names=doc_names,
    )

    note_id: str | None = None
    if payload.save and out.get("text"):
        # If exactly one doc was passed, anchor the note to it for the
        # frontend's per-file notes view; otherwise leave document_id null.
        anchor_doc = payload.documentIds[0] if (payload.documentIds and len(payload.documentIds) == 1) else None
        note_id = save_note(
            user_id=payload.userId,
            course_id=payload.courseId,
            document_id=anchor_doc,
            title=payload.title or "AI study notes",
            text=out["text"],
            sources=out.get("groundedSources") or [],
        )

    return GenerateNotesResponse(
        text=out.get("text", ""),
        pageCount=out.get("pageCount"),
        lengthCue=out.get("lengthCue"),
        groundedSources=out.get("groundedSources", []),
        warning=out.get("warning"),
        noteId=note_id,
        model=out.get("model"),
        promptTokens=out.get("promptTokens"),
        completionTokens=out.get("completionTokens"),
    )

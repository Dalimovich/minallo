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


# ── /generate-quiz ───────────────────────────────────────────────────────────


class GenerateQuizRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    # Parallelised in quiz.py — 20 fits comfortably under Netlify's 30s.
    requestedCount: int = Field(10, ge=1, le=20)
    difficulty: str = "medium"             # easy | medium | hard | mixed
    questionTypes: list[str] | None = None  # subset of ['mcq','true_false','short_answer']
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


@router.post("/generate-quiz", response_model=GenerateQuizResponse)
async def generate_quiz_endpoint(payload: GenerateQuizRequest) -> GenerateQuizResponse:
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


# ── /generate-flashcards ─────────────────────────────────────────────────────


class GenerateFlashcardsRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    # Parallelised in flashcards.py — 24 fits comfortably under Netlify's 30s.
    requestedCount: int = Field(10, ge=1, le=24)
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
async def generate_flashcards_endpoint(payload: GenerateFlashcardsRequest) -> GenerateFlashcardsResponse:
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
async def generate_notes_endpoint(payload: GenerateNotesRequest) -> GenerateNotesResponse:
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

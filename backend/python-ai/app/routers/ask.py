"""POST /retrieve-context and POST /ask.

Both guarded by the internal-token dependency. user_id is the
JWT-derived value passed in by the Netlify proxy and is cross-checked
against every document referenced in the request, so a request can
never escape the requesting user's own data.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.answer import DEFAULT_TUTOR_MODE, generate_answer, normalise_tutor_mode
from ..services.cache import fetch_document_version_hash, lookup_answer, save_answer
from ..services.retrieval import (
    ExerciseHit,
    FormulaHit,
    find_exercise_reference,
    retrieve_chunks,
    retrieve_exercise_block,
    retrieve_formula_block,
)
from ..services.retrieval_debug import DebugPayload, record_retrieval_debug
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="",
    tags=["ask"],
    dependencies=[Depends(require_internal_token)],
)

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _require_uuid(value: str, label: str) -> None:
    if not value or not _UUID_RE.match(value):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{label} must be a UUID")


def _prepend_exercise_chunks(hit: ExerciseHit, chunks: list) -> list:
    """Convert an ExerciseHit into RetrievedChunk-shaped entries and push them
    to the front of the chunk list. The answerer treats them as the highest-
    priority context for the question.
    """
    from ..services.retrieval import RetrievedChunk  # local import: avoids cycle

    prepended: list[RetrievedChunk] = [
        RetrievedChunk(
            chunk_id=f"exercise-{hit.exercise_number}-{hit.subpart or 'main'}",
            document_id=hit.document_id,
            page_start=hit.page_start,
            page_end=hit.page_end,
            text=hit.statement_markdown,
            score=99.0,           # synthetic high score so downstream sorts keep it on top
            similarity=1.0,
            chunk_type="exercise",
            is_synthetic=True,
            section_title=f"Aufgabe {hit.exercise_number}"
                + (f" ({hit.subpart})" if hit.subpart else ""),
        )
    ]
    if hit.solution_markdown:
        prepended.append(RetrievedChunk(
            chunk_id=f"solution-{hit.exercise_number}-{hit.subpart or 'main'}",
            document_id=hit.document_id,
            page_start=hit.page_start,
            page_end=hit.page_end,
            text=hit.solution_markdown,
            score=98.0,
            similarity=1.0,
            chunk_type="solution",
            section_title=f"Lösung {hit.exercise_number}"
                + (f" ({hit.subpart})" if hit.subpart else ""),
            is_synthetic=True,
        ))
    # Drop any chunks already returned for this document/page so we don't
    # duplicate context, then concat.
    keep = [
        c for c in chunks
        if not (c.document_id == hit.document_id and
                c.page_start == hit.page_start and
                c.chunk_type in ("exercise", "solution"))
    ]
    return prepended + keep


def _prepend_formula_chunks(hits: list[FormulaHit], chunks: list) -> list:
    """Convert FormulaHits into RetrievedChunk-shaped entries and push them
    to the front of the chunk list. Same shape trick as the exercise helper
    so the answerer doesn't need to know formulas are a separate source.
    """
    if not hits:
        return chunks
    from ..services.retrieval import RetrievedChunk  # local import: avoids cycle

    prepended: list[RetrievedChunk] = []
    for i, h in enumerate(hits):
        title = h.formula_name or "Formel"
        symbols = ", ".join(h.symbols) if h.symbols else ""
        body = h.formula_markdown
        if symbols:
            body = f"{body}\n\nSymbols: {symbols}"
        prepended.append(RetrievedChunk(
            chunk_id=f"formula-{h.document_id}-{h.page_number}-{i}",
            document_id=h.document_id,
            page_start=h.page_number,
            page_end=h.page_number,
            text=body,
            score=97.0 - i,        # below exercise (99/98), above vector hits
            similarity=1.0,
            chunk_type="formula",
            section_title=title,
            is_synthetic=True,
        ))
    # Drop any vector chunks already pointing at the same (doc, page) so we
    # don't duplicate context.
    skip = {(h.document_id, h.page_number) for h in hits}
    keep = [
        c for c in chunks
        if (c.document_id, c.page_start) not in skip
    ]
    return prepended + keep


def _verify_user_owns_documents(user_id: str, course_id: str, document_ids: list[str] | None) -> dict[str, str]:
    """Confirm every requested document belongs to this user+course.

    Returns id → file_name map for the documents that exist. Raises 404 on
    any mismatch — we deliberately don't 403 so we don't leak existence
    info about other users' rows.
    """
    if not document_ids:
        return {}
    sb = get_supabase()
    resp = (
        sb.table("documents")
        .select("id, user_id, course_id, file_name")
        .in_("id", document_ids)
        .execute()
    )
    rows = resp.data or []
    if len(rows) != len(document_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    for row in rows:
        if row["user_id"] != user_id or row["course_id"] != course_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    return {row["id"]: row["file_name"] for row in rows}


# ── /retrieve-context ────────────────────────────────────────────────────────


class RetrieveContextRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = None
    activeDocumentId: str | None = None
    query: str
    mode: str = "answer"
    topK: int = 12


class RetrievedChunkPayload(BaseModel):
    chunkId: str
    documentId: str
    pageStart: int | None = None
    pageEnd: int | None = None
    text: str
    score: float
    similarity: float
    chunkType: str
    sectionTitle: str | None = None


class RetrieveContextResponse(BaseModel):
    chunks: list[RetrievedChunkPayload]


@router.post("/retrieve-context", response_model=RetrieveContextResponse)
async def retrieve_context_endpoint(payload: RetrieveContextRequest) -> RetrieveContextResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")
    _verify_user_owns_documents(payload.userId, payload.courseId, payload.documentIds)
    if payload.activeDocumentId:
        _verify_user_owns_documents(payload.userId, payload.courseId, [payload.activeDocumentId])

    chunks = retrieve_chunks(
        user_id=payload.userId,
        course_id=payload.courseId,
        query=payload.query,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
        top_k=max(1, min(payload.topK, 40)),
    )
    record_retrieval_debug(DebugPayload(
        user_id=payload.userId, course_id=payload.courseId,
        endpoint="retrieve-context", question=payload.query,
        active_document_id=payload.activeDocumentId,
        selected_document_ids=payload.documentIds,
        retrieval_strategy="vector+bm25",
        retrieval_mode=None, candidate_doc_count=None, exercise_hit=None,
        chunks=chunks,
    ))
    return RetrieveContextResponse(chunks=[RetrievedChunkPayload(**c.to_api()) for c in chunks])


# ── /ask ─────────────────────────────────────────────────────────────────────


class AskRequest(BaseModel):
    userId: str
    courseId: str
    documentIds: list[str] | None = Field(default=None, description="Optional filter; required for grounded answers in practice.")
    activeDocumentId: str | None = Field(default=None, description="Document the user is currently reading; +0.25 retrieval boost.")
    question: str
    bypassCache: bool = False
    tutorMode: str | None = Field(
        default=None,
        description="Tutor-mode overlay: explain | solve | quiz. Defaults to 'solve'.",
    )


class AskSourcePayload(BaseModel):
    fileName: str
    pageStart: int | None = None
    pageEnd: int | None = None
    sectionTitle: str | None = None
    chunkType: str | None = None
    similarity: float | None = None


class VerificationPayload(BaseModel):
    status: str                                  # verified | partially_verified | missing_context
    reasons: list[str] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)


class AskResponse(BaseModel):
    answer: str
    retrievalMode: str                          # strong | weak | none
    answerMode: str | None = None               # math | strong | weak  (Phase 9)
    tutorMode: str | None = None                # explain | solve | quiz (phase 1 tutor)
    verification: VerificationPayload | None = None  # Phase 10
    groundedSources: list[AskSourcePayload]
    cacheHit: bool
    model: str | None = None
    promptTokens: int | None = None
    completionTokens: int | None = None


@router.post("/ask", response_model=AskResponse)
async def ask_endpoint(payload: AskRequest) -> AskResponse:
    _require_uuid(payload.userId, "userId")
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")
    doc_name_map = _verify_user_owns_documents(payload.userId, payload.courseId, payload.documentIds)
    if payload.activeDocumentId:
        doc_name_map.update(_verify_user_owns_documents(
            payload.userId, payload.courseId, [payload.activeDocumentId]
        ))

    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is required")

    tutor_mode = normalise_tutor_mode(payload.tutorMode or DEFAULT_TUTOR_MODE)

    # ── 1. Cache lookup ──────────────────────────────────────────────────────
    # Only the legacy 'explain' mode is cacheable. 'solve' is conversational
    # (the same question yields different turns depending on prior context)
    # and 'quiz' is generative — caching either would defeat the mode.
    version_hash = ""
    # Cache scope tightened — also disable cache entirely for deictic
    # questions ("explain this", "warum hier", etc.) because the answer
    # references the visible PDF section, which the question string alone
    # doesn't carry.
    from ..services.answer_stream import _is_deictic_question  # noqa: WPS433
    cacheable = (
        tutor_mode == "explain"
        and not _is_deictic_question(question)
    )
    if payload.documentIds and not payload.bypassCache and cacheable:
        version_hash = fetch_document_version_hash(
            payload.userId, payload.courseId, payload.documentIds
        )
        cached = lookup_answer(
            user_id=payload.userId,
            course_id=payload.courseId,
            question=question,
            version_hash=version_hash,
            tutor_mode=tutor_mode,
            active_document_id=payload.activeDocumentId,
            # Non-stream /ask doesn't accept a visibleContext payload yet.
            # Streaming does — covered below.
            visible_context=None,
        )
        if cached:
            record_retrieval_debug(DebugPayload(
                user_id=payload.userId, course_id=payload.courseId,
                endpoint="ask", question=question,
                active_document_id=payload.activeDocumentId,
                selected_document_ids=payload.documentIds,
                retrieval_strategy="cache",
                retrieval_mode=cached.get("retrievalMode", "strong"),
                candidate_doc_count=None, exercise_hit=None, chunks=[],
                model=cached.get("model"), cache_hit=True,
                prompt_tokens=cached.get("promptTokens"),
                completion_tokens=cached.get("completionTokens"),
            ))
            cached_verification = cached.get("verification")
            return AskResponse(
                answer=cached.get("answer", ""),
                retrievalMode=cached.get("retrievalMode", "strong"),
                answerMode=cached.get("answerMode"),
                tutorMode=cached.get("tutorMode") or tutor_mode,
                verification=VerificationPayload(**cached_verification) if cached_verification else None,
                groundedSources=[AskSourcePayload(**s) for s in cached.get("groundedSources", [])],
                cacheHit=True,
                model=cached.get("model"),
                promptTokens=cached.get("promptTokens"),
                completionTokens=cached.get("completionTokens"),
            )

    # ── 2. Retrieve ──────────────────────────────────────────────────────────
    # Phase 5/6: when the question references an exercise by number, try the
    # exact-match lookup first. The hit (when found) is appended to the chunk
    # list as a synthetic top-priority entry so the answerer sees the exact
    # statement (and solution if available) before any similarity-based chunks.
    exercise_hit = retrieve_exercise_block(
        user_id=payload.userId,
        course_id=payload.courseId,
        query=question,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
    )

    chunks = retrieve_chunks(
        user_id=payload.userId,
        course_id=payload.courseId,
        query=question,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
        top_k=12,
    )

    if exercise_hit:
        chunks = _prepend_exercise_chunks(exercise_hit, chunks)

    # Formula exact-match: cheap heuristic over document_formulas. Surfaces
    # the canonical formula when the question names it (or its symbol)
    # before the vector ranker gets to pick a general explanation chunk.
    formula_hits = retrieve_formula_block(
        user_id=payload.userId,
        course_id=payload.courseId,
        query=question,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
    )
    if formula_hits:
        chunks = _prepend_formula_chunks(formula_hits, chunks)

    # Backfill doc_name_map for any chunk pointing at a doc we didn't ask
    # about explicitly (e.g. when documentIds is None and we let retrieval
    # roam over the whole course).
    missing_ids = [c.document_id for c in chunks if c.document_id not in doc_name_map]
    if missing_ids:
        sb = get_supabase()
        try:
            resp = sb.table("documents").select("id, file_name").in_("id", list(set(missing_ids))).execute()
            for row in resp.data or []:
                doc_name_map[row["id"]] = row["file_name"]
        except Exception:
            log.exception("doc_name backfill failed")

    # ── 3. Generate ──────────────────────────────────────────────────────────
    # Phase 3: surface this student's weak topics for this course so the
    # tutor system prompt can subtly reinforce them when relevant.
    from ..services.mastery import fetch_weak_topics  # noqa: WPS433
    weak_topics = fetch_weak_topics(payload.userId, payload.courseId)
    try:
        answer = generate_answer(
            question=question,
            chunks=chunks,
            doc_names=doc_name_map,
            tutor_mode=tutor_mode,
            weak_topics=weak_topics,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("answer generation failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"answer generation failed: {e}")

    # ── 4. Save to cache for next time ───────────────────────────────────────
    if version_hash and not payload.bypassCache and cacheable:
        save_answer(
            user_id=payload.userId,
            course_id=payload.courseId,
            question=question,
            version_hash=version_hash,
            answer_json=answer,
            tutor_mode=tutor_mode,
            active_document_id=payload.activeDocumentId,
            visible_context=None,
        )

    record_retrieval_debug(DebugPayload(
        user_id=payload.userId, course_id=payload.courseId,
        endpoint="ask", question=question,
        active_document_id=payload.activeDocumentId,
        selected_document_ids=payload.documentIds,
        retrieval_strategy=(
            "+".join(
                (["exercise-exact"] if exercise_hit else [])
                + (["formula-exact"] if formula_hits else [])
                + ["vector+bm25"]
            )
        ),
        retrieval_mode=answer.get("retrievalMode"),
        candidate_doc_count=len({c.document_id for c in chunks}) if chunks else 0,
        exercise_hit=(
            {
                "documentId": exercise_hit.document_id,
                "exerciseNumber": exercise_hit.exercise_number,
                "subpart": exercise_hit.subpart,
                "pageStart": exercise_hit.page_start,
                "pageEnd": exercise_hit.page_end,
            } if exercise_hit else None
        ),
        chunks=chunks,
        model=answer.get("model"), cache_hit=False,
        prompt_tokens=answer.get("promptTokens"),
        completion_tokens=answer.get("completionTokens"),
    ))

    answer_verification = answer.get("verification")
    return AskResponse(
        answer=answer["answer"],
        retrievalMode=answer["retrievalMode"],
        answerMode=answer.get("answerMode"),
        tutorMode=answer.get("tutorMode") or tutor_mode,
        verification=VerificationPayload(**answer_verification) if answer_verification else None,
        groundedSources=[AskSourcePayload(**s) for s in answer.get("groundedSources", [])],
        cacheHit=False,
        model=answer.get("model"),
        promptTokens=answer.get("promptTokens"),
        completionTokens=answer.get("completionTokens"),
    )

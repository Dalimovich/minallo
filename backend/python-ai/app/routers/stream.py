"""POST /ask-stream — SSE-streamed RAG answer for the browser.

Browser hits this directly with the Supabase JWT in the Authorization
header. We verify the JWT against Supabase's auth API, then stream
tokens as they arrive from OpenAI. This bypasses Netlify entirely, so
the 30s function timeout never applies.

Reuses /ask's retrieval + ownership + cache logic.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import json
import re
import time
import uuid
from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import get_settings
from ..jwt_auth import verify_supabase_jwt
from ..services.access_control import (
    enforce_interactive_cap,
    enforce_rate_limit,
    require_active_subscription,
)
from ..services.answer import DEFAULT_TUTOR_MODE, is_app_question, normalise_tutor_mode
from ..services.answer_stream import _answer_matches_question_language, stream_answer
from ..services.answer_intent import (
    AcademicIntent,
    chitchat_answer,
    classify_academic_intent,
    is_non_academic_chitchat,
    wants_per_source_coverage,
)
from ..services.cache import fetch_course_version_hash, lookup_answer, save_answer
from ..services.embeddings import EmbeddingServiceUnavailable
from ..services.general_answer import generate_general_answer
from ..services.retrieval import retrieve_chunks, retrieve_exercise_block, retrieve_formula_block
from ..services.retrieval_debug import DebugPayload, record_retrieval_debug
from ..services.source_router import (
    CourseFileScope,
    SourceDecision,
    SourceScope,
    auto_general_prefix,
    classify_source_scope,
    course_not_found_answer,
    course_relevance_score,
    effective_document_ids,
)
from ..services.web_answer import generate_web_answer
from ..services.usage_meter import record_usage
from ..services.workspace_context import (
    detect_assistant_mode,
    fetch_account_snapshot,
    fetch_workspace_snapshot,
    format_account_block,
    format_workspace_block,
    is_workspace_question,
    match_course_in_text,
    sanitize_page_context,
    workspace_fingerprint,
)
from ..supabase_client import get_supabase

# Same hourly cap as the Netlify /api/ai/ask path so the two surfaces share
# one budget. Override via env if needed; defaults to 30/hour to leave headroom
# for the new tighter limits and stay well inside per-user cost expectations.
_ASK_STREAM_RATE_LIMIT_MAX = 30
_ASK_STREAM_RATE_LIMIT_WINDOW_SECONDS = 60 * 60
_MAX_STREAM_QUESTION_CHARS = 8000
_MAX_STREAM_OPEN_FILE_CTX_CHARS = 20000
_MAX_OPEN_FILE_IMAGES = 2
_MAX_OPEN_FILE_IMAGE_BASE64_CHARS = 2_500_000
_ALLOWED_OPEN_FILE_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
# Mirror backend/lib/rate-limit.ts INTERACTIVE_MONTHLY_CAP. /ask-stream is an
# interactive RAG call (cheap per request on gpt-4o-mini) so it lives in the
# interactive bucket alongside /api/ai/ask and the writing coach.
_INTERACTIVE_MONTHLY_CAP = 2000

_BROAD_RETRIEVAL_RE = re.compile(
    r"\b(whole|entire|complete|all|every|compare|study guide|full course|across)\b|"
    r"\b(gesamte|alle|jeder|vergleiche|lernplan|vollständig)\b",
    re.IGNORECASE,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["ask-stream"])

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _require_uuid(value: str, label: str) -> None:
    if not value or not _UUID_RE.match(value):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{label} must be a UUID")


def _retrieval_limit(question: str, selected_document_count: int, generative: bool = False) -> int:
    """Small defaults for direct questions; preserve breadth for coverage requests."""
    if generative or _BROAD_RETRIEVAL_RE.search(question or ""):
        return 18 if selected_document_count <= 6 else min(48, selected_document_count * 3)
    if selected_document_count <= 1:
        return 8
    if selected_document_count <= 3:
        return 10
    return 12


def _deduplicate_chunks(chunks: list[Any]) -> list[Any]:
    """Preserve priority order while removing repeated page/text variants."""
    kept: list[Any] = []
    fingerprints: set[tuple[str, int | None, str]] = set()
    token_sets: list[set[str]] = []
    for chunk in chunks:
        text_value = re.sub(r"\s+", " ", (getattr(chunk, "text", "") or "").lower()).strip()
        fingerprint = (
            getattr(chunk, "document_id", "") or "",
            getattr(chunk, "page_start", None),
            text_value[:500],
        )
        if fingerprint in fingerprints:
            continue
        words = set(re.findall(r"\w+", text_value[:2000]))
        if words and any(len(words & prior) / max(1, len(words | prior)) >= 0.92 for prior in token_sets):
            continue
        fingerprints.add(fingerprint)
        token_sets.append(words)
        kept.append(chunk)
    return kept


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


def _resolve_document_ids_by_name(user_id: str, course_id: str, names: list[str] | None) -> list[str]:
    """Resolve storage file names → owned document ids in this course.

    The chatbot's "Selected file(s)" scope only knows file names (the document
    id lives server-side), so it sends names; this maps them to ids for scoped
    retrieval. Best-effort: returns [] on error or no match (caller then falls
    back to a whole-course search rather than dead-ending)."""
    clean = list(dict.fromkeys(n.strip() for n in (names or []) if n and n.strip()))[:50]
    if not clean:
        return []
    sb = get_supabase()
    # Pull all of the course's documents once and match in Python so a tiny
    # name mismatch (case, a missing/extra .pdf extension, surrounding spaces)
    # doesn't silently drop the whole selection back to a whole-course search.
    try:
        resp = (
            sb.table("documents")
            .select("id, file_name")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .limit(2000)
            .execute()
        )
    except Exception:
        log.exception("resolve document ids by name failed")
        return []

    def _norm(s: str) -> str:
        s = (s or "").strip().lower()
        return s[:-4] if s.endswith(".pdf") else s

    wanted = {_norm(n) for n in clean}
    out: list[str] = []
    for row in (resp.data or []):
        fn = row.get("file_name") or ""
        if row.get("id") and (fn.strip().lower() in {n.lower() for n in clean} or _norm(fn) in wanted):
            out.append(row["id"])
    return out


class PreviousTurn(BaseModel):
    """One prior question/answer pair from the same chat session.
    The streaming endpoint accepts a short list of these so the model can
    resolve follow-up references like "the formula above" or "explain
    the same thing in simpler terms" without re-running retrieval."""
    role: str   # "user" | "assistant"
    text: str


class ProblemSolverPayload(BaseModel):
    mode: str
    problem: str
    studentWork: str | None = None


class OpenFileImagePayload(BaseModel):
    mediaType: str = "image/jpeg"
    data: str
    page: int | None = None


class PageContextPayload(BaseModel):
    """Where the student currently is in the Minallo UI. Only facts the server
    can't know; sanitised + clamped in workspace_context.sanitize_page_context.
    Workspace DATA (counts, names) is never accepted from the client."""
    page: str | None = None          # e.g. "course" | "pdf-viewer" | "chatbot"
    courseName: str | None = None
    activeTab: str | None = None     # files|quiz|flashcards|examforge|cheatsheet|deeplearn
    documentTitle: str | None = None


class SelectedRegionPayload(BaseModel):
    page: int = Field(ge=1)
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)
    id: str | None = None
    origin: str | None = None
    extractionMethod: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    documentRevision: str | None = None
    nearbyQuestionLabel: str | None = None
    cropHash: str | None = None


class AskStreamRequest(BaseModel):
    courseId: str
    documentIds: list[str] | None = None
    # "Selected file(s)" scope from the chatbot, which only knows storage file
    # NAMES (the document id lives server-side). Resolved to document ids here.
    documentNames: list[str] | None = None
    activeDocumentId: str | None = None
    question: str
    # The file name + a slice of text from whatever the user is currently
    # looking at in the PDF reader. Surfaced into the user message so the
    # model can ground "this question / this section" references even when
    # retrieval doesn't surface the exact chunk. Both optional.
    activeFileName: str | None = None
    visiblePage: int | None = None
    selectedText: str | None = None
    selectedRegion: SelectedRegionPayload | None = None
    viewerRevision: str | None = None
    conversationId: str | None = None
    conversationGeneration: int | None = Field(default=None, ge=0)
    responseLanguage: str | None = None
    openFileContext: str | None = None
    openFileImages: list[OpenFileImagePayload] | None = None
    # Tutor-mode overlay: explain | solve | quiz. Defaults to 'explain'.
    tutorMode: str | None = None
    sourceMode: str | None = "auto"
    courseFileScope: str | None = "all_course_files"
    # Recent transcript for this file-scoped chat, newest last. The answer
    # service enforces per-turn, message-count, and total-character caps.
    previousTurns: list[PreviousTurn] | None = None
    problemSolver: ProblemSolverPayload | None = None
    # Current UI location (page / course tab / open document title). Optional;
    # sanitised server-side. Lets the assistant answer "where am I, what can I
    # do here" and point at the right course tab.
    pageContext: PageContextPayload | None = None
    # bypassCache is intentionally NOT exposed on the public API. The cache
    # is keyed by document_version_hash so it invalidates automatically when
    # documents change; letting the client opt out defeats the single biggest
    # cost mitigation. Any field the client sends is ignored.


def _sse_bytes(payload: str) -> bytes:
    return ("data: " + payload + "\n\n").encode("utf-8")


def _status_sse(status_key: str) -> bytes:
    return _sse_bytes(json.dumps({"status": status_key}, ensure_ascii=False))


def _verification_requires_rejection(verification: Any) -> bool:
    details = verification.get("details") if isinstance(verification, dict) else {}
    return bool(
        isinstance(details, dict)
        and (
            details.get("criticalNumericalMismatch")
            or details.get("numberMisses")
            or details.get("fabricatedFilenames")
            or details.get("invalidSourceIndices")
            or details.get("fakeSolutionPhrases")
        )
    )


def _verification_is_cacheable(verification: Any) -> bool:
    return bool(
        isinstance(verification, dict)
        and verification.get("status") == "verified"
        and not _verification_requires_rejection(verification)
    )


def _source_debug_enabled() -> bool:
    try:
        from ..config import get_settings  # noqa: WPS433
        return get_settings().environment.lower() != "production"
    except Exception:
        return False


def _source_meta(decision: SourceDecision, *, cache_hit: bool | None = None) -> dict[str, Any]:
    return decision.metadata(include_debug=_source_debug_enabled(), cache_hit=cache_hit)


def _stream_static_answer(
    *,
    text: str,
    decision: SourceDecision,
    answer_mode: str,
    sources: list[dict[str, Any]] | None = None,
    model: str | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    status_key: str = "writing_answer",
    extra_meta: dict[str, Any] | None = None,
):
    sources = sources or []
    extra_meta = extra_meta or {}

    def gen():
        confidence = "low" if answer_mode == "clarification" else "high"
        unsupported = answer_mode == "clarification"
        yield _status_sse(status_key)
        meta = {
            "meta": True,
            "retrievalMode": decision.source_scope.value,
            "answerMode": answer_mode,
            "confidence": confidence,
            "unsupported": unsupported,
            **extra_meta,
            **_source_meta(decision, cache_hit=False),
        }
        yield _sse_bytes(json.dumps(meta, ensure_ascii=False))
        for i in range(0, len(text), 48):
            yield _sse_bytes(json.dumps({"t": text[i:i + 48]}, ensure_ascii=False))
        yield _sse_bytes(json.dumps({
            "done": True,
            "retrievalMode": decision.source_scope.value,
            "answerMode": answer_mode,
            "confidence": confidence,
            "unsupported": unsupported,
            "sources": sources,
            "cacheHit": False,
            "model": model,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            **extra_meta,
            **_source_meta(decision, cache_hit=False),
        }, ensure_ascii=False))

    return StreamingResponse(gen(), media_type="text/event-stream")


def _validate_open_file_images(images: list[OpenFileImagePayload] | None) -> list[dict[str, Any]]:
    if not images:
        return []
    if len(images) > _MAX_OPEN_FILE_IMAGES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="too many openFileImages")

    normalised: list[dict[str, Any]] = []
    for img in images:
        media_type = (img.mediaType or "image/jpeg").strip().lower()
        data = (img.data or "").strip()
        if media_type not in _ALLOWED_OPEN_FILE_IMAGE_TYPES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unsupported openFileImages mediaType")
        if not data:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileImages data is required")
        if len(data) > _MAX_OPEN_FILE_IMAGE_BASE64_CHARS:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileImages data is too long")
        if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", data):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileImages data must be base64")
        normalised.append({"mediaType": media_type, "data": data, "page": img.page})
    return normalised


def _augment_retrieval_query_with_open_context(
    *,
    question: str,
    retrieval_query: str,
    open_file_context: str | None,
    has_problem_solver: bool,
) -> str:
    """Let retrieval see the exercise text when the user asks about "this".

    The answer prompt already receives Source 0, but retrieval also needs the
    visible problem wording so it can pull the matching lecture/formula chunks.
    Keep the excerpt short to avoid turning BM25 into a full-document search.
    """
    open_ctx = (open_file_context or "").strip()
    if not open_ctx:
        return retrieval_query

    from ..services.answer_stream import _is_deictic_question  # noqa: WPS433

    q_norm = (question or "").strip()
    should_augment = (
        has_problem_solver
        or _is_deictic_question(q_norm)
        or len(q_norm) <= 60
        or len(q_norm.split()) <= 8
    )
    if not should_augment:
        return retrieval_query

    return (retrieval_query.strip() + "\n\nVisible PDF context:\n" + open_ctx[:2000]).strip()


def _cached_grounded_sources_to_js(grounded_sources: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Translate cached Python-shape sources without dropping page labels."""
    sources_js: list[dict[str, Any]] = []
    for s in grounded_sources or []:
        page_start = s.get("pageStart")
        page_end = s.get("pageEnd")
        pages = s.get("pages")
        if not pages and page_start and page_end:
            pages = str(page_start) if page_start == page_end else f"{page_start}-{page_end}"
        elif not pages and page_start:
            pages = str(page_start)
        sources_js.append({
            "file_name": s.get("fileName") or s.get("file_name") or "Unknown",
            "pages": pages,
            "section": s.get("sectionTitle") or s.get("section"),
            # documentId + pageStart let the frontend open the cited PDF by id
            # (robust against mangled file names) at the right page.
            "documentId": s.get("documentId") or s.get("document_id"),
            "pageStart": page_start,
            "index": s.get("index"),
        })
    return sources_js


def _web_sources_to_js(sources: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [
        {
            "file_name": s.get("title") or s.get("url") or "Web source",
            "title": s.get("title"),
            "url": s.get("url"),
            "snippet": s.get("snippet"),
        }
        for s in (sources or [])
    ]


@router.post("/ask-stream")
async def ask_stream_endpoint(payload: AskStreamRequest, user: dict = Depends(verify_supabase_jwt)):
    """Complete access preflight, then expose the deferred pipeline over SSE."""
    started = time.perf_counter()
    request_id = uuid.uuid4().hex
    user_id = user["id"]
    access_started = time.perf_counter()
    await run_in_threadpool(lambda: require_active_subscription(user_id, "ask_stream"))
    await run_in_threadpool(lambda: enforce_interactive_cap(user_id, _INTERACTIVE_MONTHLY_CAP))
    await run_in_threadpool(
        lambda: enforce_rate_limit(
            user_id, "ask_stream", _ASK_STREAM_RATE_LIMIT_MAX,
            _ASK_STREAM_RATE_LIMIT_WINDOW_SECONDS,
            "AI request limit reached. Please try again later.",
        )
    )
    access_ms = (time.perf_counter() - access_started) * 1000

    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")
    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is required")
    if len(question) > _MAX_STREAM_QUESTION_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is too long")
    if payload.openFileContext and len(payload.openFileContext) > _MAX_STREAM_OPEN_FILE_CTX_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileContext is too long")
    if payload.selectedText and len(payload.selectedText) > 12000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="selectedText is too long")
    if payload.visiblePage is not None and payload.visiblePage < 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="visiblePage must be positive")
    _validate_open_file_images(payload.openFileImages)

    resolved_ids = list(payload.documentIds) if payload.documentIds else []
    if not resolved_ids and payload.documentNames:
        resolved_ids = await run_in_threadpool(
            lambda: _resolve_document_ids_by_name(user_id, payload.courseId, payload.documentNames)
        )
    preflight_doc_names = await run_in_threadpool(
        lambda: _verify_user_owns_documents(user_id, payload.courseId, resolved_ids)
    )
    if payload.activeDocumentId:
        preflight_doc_names.update(await run_in_threadpool(
            lambda: _verify_user_owns_documents(user_id, payload.courseId, [payload.activeDocumentId])
        ))
    preflight_ms = (time.perf_counter() - started) * 1000

    async def early_stream():
        first_sse_ms = (time.perf_counter() - started) * 1000
        yield _status_sse("reading_question")
        log.info(
            "ai_stream_timing request_id=%s phase=first_sse access_ms=%.0f preflight_ms=%.0f first_sse_ms=%.0f",
            request_id, access_ms, preflight_ms, first_sse_ms,
        )
        try:
            status_queue: asyncio.Queue[str] = asyncio.Queue()
            prepared_task = asyncio.create_task(
                _prepare_ask_stream_response(
                    payload, user, status_queue.put_nowait, request_id,
                    {"resolved_document_ids": resolved_ids, "doc_name_map": preflight_doc_names},
                )
            )
            while not prepared_task.done():
                try:
                    status_key = await asyncio.wait_for(status_queue.get(), timeout=0.1)
                    yield _status_sse(status_key)
                except asyncio.TimeoutError:
                    continue
            prepared = await prepared_task
            while not status_queue.empty():
                yield _status_sse(status_queue.get_nowait())
            async for event in prepared.body_iterator:
                yield event
        except HTTPException as exc:
            yield _sse_bytes(json.dumps({"error": str(exc.detail), "status": exc.status_code}))
        except Exception:
            log.exception("ask_stream deferred pipeline failed request_id=%s", request_id)
            yield _sse_bytes(json.dumps({"error": "Unable to answer right now. Please try again."}))
        finally:
            log.info(
                "ai_stream_timing request_id=%s phase=total total_ms=%.0f",
                request_id, (time.perf_counter() - started) * 1000,
            )

    return StreamingResponse(early_stream(), media_type="text/event-stream")


async def _prepare_ask_stream_response(
    payload: AskStreamRequest, user: dict, status_sink=None, request_id: str | None = None,
    preflight: dict[str, Any] | None = None,
):
    request_started = time.perf_counter()
    request_id = request_id or uuid.uuid4().hex
    user_id = user["id"]
    from ..services.request_generation import register_generation  # noqa: WPS433
    register_generation(user_id, payload.conversationId, payload.conversationGeneration)
    # Paid feature — verify subscription before doing anything expensive.

    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")

    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is required")
    if len(question) > _MAX_STREAM_QUESTION_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is too long")

    tutor_mode = normalise_tutor_mode(payload.tutorMode or DEFAULT_TUTOR_MODE)
    if payload.openFileContext and len(payload.openFileContext) > _MAX_STREAM_OPEN_FILE_CTX_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileContext is too long")
    open_file_images = _validate_open_file_images(payload.openFileImages)
    previous_turns_payload: list[dict[str, str]] = [
        {"role": t.role, "text": t.text} for t in (payload.previousTurns or [])
    ]

    # "Selected file(s)" scope: the chatbot sends file NAMES (it has no document
    # ids), so resolve them to ids here. Fall back to ids the client did send.
    resolved_document_ids = list((preflight or {}).get("resolved_document_ids") or [])
    if not preflight and not resolved_document_ids and payload.documentNames:
        resolved_document_ids = await run_in_threadpool(
            lambda: _resolve_document_ids_by_name(user_id, payload.courseId, payload.documentNames)
        )
    # If the chat asked for specific files but none resolved, don't dead-end on
    # a "which file?" clarification — search the whole course instead (it still
    # includes the selected files), so the user always gets a grounded answer.
    effective_scope = payload.courseFileScope
    if (payload.courseFileScope or "").strip().lower() == "specific_files" and not resolved_document_ids:
        effective_scope = "all_course_files"

    if preflight:
        doc_name_map = dict(preflight.get("doc_name_map") or {})
    else:
        doc_name_map = await run_in_threadpool(
            lambda: _verify_user_owns_documents(user_id, payload.courseId, resolved_document_ids)
        )
        if payload.activeDocumentId:
            doc_name_map.update(await run_in_threadpool(
                lambda: _verify_user_owns_documents(user_id, payload.courseId, [payload.activeDocumentId])
            ))

    from ..services.reference_resolution import (  # noqa: WPS433
        decide_evidence,
        recovery_message,
        resolve_language_context,
        resolve_question_reference,
    )
    from ..services.dialogue_state import resolve_dialogue  # noqa: WPS433
    language_context = resolve_language_context(
        question,
        explicit_response_language=payload.responseLanguage,
        previous_turns=previous_turns_payload,
    )
    dialogue = resolve_dialogue(
        question,
        previous_turns=previous_turns_payload,
        response_language=language_context.requested_response_language,
    )
    if dialogue.response_language != language_context.requested_response_language:
        language_context = replace(
            language_context,
            requested_response_language=dialogue.response_language,
        )
    resolved_question = dialogue.resolved_request
    selected_region_id = payload.selectedRegion.id if payload.selectedRegion else None
    reference = resolve_question_reference(
        question=resolved_question,
        course_id=payload.courseId,
        active_document_id=payload.activeDocumentId,
        active_document_name=(
            doc_name_map.get(payload.activeDocumentId or "") or payload.activeFileName
        ),
        visible_page=payload.visiblePage,
        selected_text=payload.selectedText,
        selected_region_id=selected_region_id,
        visible_text=payload.openFileContext,
        has_visible_image=bool(open_file_images),
    )
    evidence_decision = decide_evidence(
        reference,
        question=resolved_question,
        has_history=bool(previous_turns_payload),
    )
    log.info(
        "grounding_preflight request_id=%s reference_status=%s confidence=%.2f "
        "candidate_count=%d evidence_action=%s recovery_code=%s language=%s dialogue_act=%s "
        "active_document=%s visible_page=%s",
        request_id,
        reference.status,
        reference.confidence,
        len(reference.candidate_labels),
        evidence_decision.action,
        evidence_decision.recovery_code,
        language_context.requested_response_language,
        dialogue.dialogue_act.value,
        bool(payload.activeDocumentId),
        payload.visiblePage,
    )

    source_decision = classify_source_scope(
        question=resolved_question,
        source_mode=payload.sourceMode,
        course_file_scope=effective_scope,
        selected_course_id=payload.courseId,
        document_ids=resolved_document_ids,
        active_document_id=payload.activeDocumentId,
        open_file_context=payload.openFileContext,
    )

    if not evidence_decision.can_answer:
        return _stream_static_answer(
            text=recovery_message(
                evidence_decision.recovery_code,
                language_context.requested_response_language,
            ),
            decision=source_decision,
            answer_mode="clarification",
            status_key="identifying_question",
            extra_meta={
                "recovery": {
                    "code": evidence_decision.recovery_code,
                    "action": evidence_decision.action,
                },
                "referenceResolution": reference.to_api(),
                "evidenceDecision": evidence_decision.to_api(),
                "languageContext": language_context.to_api(),
                "dialogueResolution": dialogue.to_api(),
            },
        )

    if is_non_academic_chitchat(question):
        chitchat_decision = replace(
            source_decision,
            source_scope=SourceScope.GENERAL_KNOWLEDGE,
            source_label="",
            used_document_ids=[],
            relevance_score=None,
            web_search_used=False,
        )
        return _stream_static_answer(
            text=chitchat_answer(question),
            decision=chitchat_decision,
            answer_mode="general",
            status_key="writing_answer",
        )

    app_question = is_app_question(question)
    # Workspace questions ("where are my flashcards", "which quizzes did I
    # complete", "what can I do in this course") are answered from the live
    # workspace snapshot, not lecture chunks — same routing as app questions.
    workspace_question = (
        not app_question and bool(payload.courseId) and is_workspace_question(question)
    )
    if app_question or workspace_question:
        source_decision = replace(
            source_decision,
            source_scope=SourceScope.GENERAL_KNOWLEDGE,
            source_label="",
            used_document_ids=[],
            relevance_score=None,
            web_search_used=False,
        )
    app_or_workspace = app_question or workspace_question

    if source_decision.source_scope == SourceScope.NEEDS_CLARIFICATION and not app_or_workspace:
        return _stream_static_answer(
            text=source_decision.needs_clarification_message
            or "Which file should I use? Please select a PDF or switch to All course files.",
            decision=source_decision,
            answer_mode="clarification",
            status_key="reading_question",
        )

    if source_decision.source_scope == SourceScope.INTERNET and not app_or_workspace:
        web_answer = await run_in_threadpool(
            lambda: generate_web_answer(question, query=source_decision.sanitized_web_query or question)
        )
        source_decision = replace(source_decision, web_search_used=bool(web_answer.get("webSources")))
        record_usage(
            feature="ask_stream_web", model=web_answer.get("model"),
            prompt_tokens=web_answer.get("promptTokens"),
            completion_tokens=web_answer.get("completionTokens"), user_id=user_id,
        )
        return _stream_static_answer(
            text=web_answer["answer"],
            decision=source_decision,
            answer_mode="internet",
            sources=_web_sources_to_js(web_answer.get("webSources") or []),
            model=web_answer.get("model"),
            prompt_tokens=web_answer.get("promptTokens"),
            completion_tokens=web_answer.get("completionTokens"),
            status_key="writing_answer",
        )

    if source_decision.source_scope == SourceScope.GENERAL_KNOWLEDGE and not app_or_workspace:
        prefix = auto_general_prefix() if source_decision.selected_source_mode.value == "auto" else ""
        general = await run_in_threadpool(lambda: generate_general_answer(question, prefix=prefix))
        record_usage(
            feature="ask_stream_general", model=general.get("model"),
            prompt_tokens=general.get("promptTokens"),
            completion_tokens=general.get("completionTokens"), user_id=user_id,
        )
        return _stream_static_answer(
            text=general["answer"],
            decision=source_decision,
            answer_mode="general",
            model=general.get("model"),
            prompt_tokens=general.get("promptTokens"),
            completion_tokens=general.get("completionTokens"),
            status_key="writing_answer",
        )

    # ── Live workspace context (layer 2: the student's real Minallo data) ────
    # Server-fetched, user-scoped; the client only contributes the sanitised UI
    # location. The block rides the system prompt for every course request, and
    # its fingerprint joins the cache key so "you have 3 quizzes" answers die
    # the moment a 4th appears. All best-effort — never blocks answering.
    page_context = sanitize_page_context(
        payload.pageContext.model_dump() if payload.pageContext else None
    )
    workspace_snapshot = None
    weak_topics: list[str] = []
    if payload.courseId:
        if status_sink:
            status_sink("collecting_sources")
        from ..services.mastery import fetch_weak_topics  # noqa: WPS433
        context_started = time.perf_counter()
        workspace_snapshot, weak_topics = await asyncio.gather(
            run_in_threadpool(lambda: fetch_workspace_snapshot(user_id, payload.courseId)),
            run_in_threadpool(lambda: fetch_weak_topics(user_id, payload.courseId)),
        )
        log.info(
            "ai_stream_timing request_id=%s phase=context context_ms=%.0f",
            request_id, (time.perf_counter() - context_started) * 1000,
        )
    # App/workspace questions ("what courses do I have?") need the account-wide
    # course list: the per-course snapshot above cannot name the student's other
    # courses, which is exactly what the model used to invent.
    account_snapshot = None
    named_course_name: str | None = None
    if app_or_workspace:
        account_snapshot = await run_in_threadpool(lambda: fetch_account_snapshot(user_id))
        # "what cheatsheets do I have in Technische Mechanik 2" — the question
        # names a course. Swap the workspace snapshot to THAT course; the
        # active-course snapshot would silently describe the wrong one.
        named_course = match_course_in_text(account_snapshot, question)
        if named_course and named_course.get("id"):
            if named_course["id"] == payload.courseId:
                named_course_name = named_course["name"]
            else:
                named_snapshot = await run_in_threadpool(
                    lambda: fetch_workspace_snapshot(user_id, named_course["id"])
                )
                if named_snapshot:
                    workspace_snapshot = named_snapshot
                    # Weak topics were fetched for the active course — they
                    # must not be attributed to the named one.
                    weak_topics = []
                    named_course_name = named_course["name"]
    workspace_block = format_workspace_block(
        workspace_snapshot, page_context=page_context, weak_topics=weak_topics,
        course_name=named_course_name,
    )
    if account_snapshot:
        workspace_block += format_account_block(account_snapshot, in_course_chat=True)
    ws_fingerprint = workspace_fingerprint(
        {"s": workspace_snapshot, "w": weak_topics, "p": page_context,
         "a": account_snapshot, "n": named_course_name}
    ) if workspace_block else ""
    assistant_mode = detect_assistant_mode(question)

    # ── Cache check (same logic as /ask) ─────────────────────────────────────
    # When the request carries openFileContext (the user is reading a PDF
    # and asking "this question / this section"), the answer is bound to
    # whatever page is visible — not just the document set. Bypass cache to
    # avoid returning a previous answer composed against a different page.
    version_hash = ""
    cached = None
    has_open_ctx = bool(payload.openFileContext and payload.openFileContext.strip()) or bool(open_file_images)
    # Cache only makes sense for the legacy 'explain' mode. 'solve' is
    # conversational and 'quiz' is generative, so we never want to serve
    # a stale answer for either. Also bypass cache for deictic questions and
    # whenever there's open-PDF context — those answers depend on the visible
    # page, not just the question.
    from ..services.answer_stream import _is_deictic_question  # noqa: WPS433
    # Exam generation and "a question for every selected file" are generative and
    # selection-dependent — serving a previous answer here is exactly the stale
    # bug that made fixes look like no-ops (an old cached exam shadowed the new
    # one). Always regenerate these; never look up or save a cached answer.
    generative_request = (
        wants_per_source_coverage(question)
        or classify_academic_intent(question) == AcademicIntent.EXAM_GENERATION
    )
    cacheable = (
        tutor_mode == "explain"
        and dialogue.requires_new_retrieval
        and not _is_deictic_question(question)
        and payload.problemSolver is None
        and not has_open_ctx
        and not generative_request
    )
    # Normalise previousTurns once — folded into the cache key (two students
    # asking "explain that again" in different sessions must not collide) and
    # reused for retrieval/answer below.
    # Academic answers search the whole course even when the UI has a selected
    # document (lecture/formula PDFs hold the method while the selected PDF only
    # holds the exercise). So the cache is keyed on a WHOLE-COURSE version hash:
    # any document change in the course invalidates it. lookup and save MUST
    # pass identical key args, so both use cache_key_kwargs.
    course_file_scope = CourseFileScope(source_decision.course_file_scope.value)
    retrieval_document_ids = effective_document_ids(
        document_ids=resolved_document_ids,
        active_document_id=payload.activeDocumentId,
        course_file_scope=course_file_scope,
    )
    cache_key_kwargs = {
        "tutor_mode": tutor_mode,
        "active_document_id": payload.activeDocumentId,
        "visible_context": payload.openFileContext,
        "previous_turns": previous_turns_payload,
        "source_mode": source_decision.selected_source_mode.value,
        "source_scope": source_decision.source_scope.value,
        "course_file_scope": source_decision.course_file_scope.value,
        "selected_document_ids": retrieval_document_ids,
        "workspace_fingerprint": ws_fingerprint or None,
        "visible_page": payload.visiblePage,
        "selected_region_fingerprint": (
            json.dumps(payload.selectedRegion.model_dump(), sort_keys=True)
            if payload.selectedRegion else None
        ),
        "response_language": language_context.requested_response_language,
        "viewer_revision": payload.viewerRevision,
        "grounding_mode": "strict-course-files",
        "conversation_generation": payload.conversationGeneration,
        "model_version": (
            f"{get_settings().openai_generate_model}|"
            f"{get_settings().openai_generate_model_strong}"
        ),
    }
    if cacheable:
        if status_sink:
            status_sink("checking_cache")
        cache_started = time.perf_counter()
        version_hash = await run_in_threadpool(lambda: fetch_course_version_hash(user_id, payload.courseId))
        if version_hash:
            cached = await run_in_threadpool(
                lambda: lookup_answer(
                    user_id=user_id, course_id=payload.courseId,
                    question=question, version_hash=version_hash,
                    **cache_key_kwargs,
                )
            )
        log.info(
            "ai_stream_timing request_id=%s phase=cache cache_ms=%.0f cache_hit=%s",
            request_id, (time.perf_counter() - cache_started) * 1000, bool(cached),
        )

    def cached_stream():
        # Replay cached answers in small chunks so cache hits still feel like
        # the live stream instead of appearing as one sudden blob.
        import json
        # Cached answers carry the verification block they were generated
        # with — honour it instead of falling back to the legacy
        # retrievalMode→confidence mapping (which mislabels uncited answers
        # as 'high').
        cached_v = cached.get("verification") if isinstance(cached, dict) else None
        cached_v_status = cached_v.get("status") if isinstance(cached_v, dict) else None
        if cached_v_status == "verified":
            cached_confidence = "high"
        elif cached_v_status == "partially_verified":
            cached_confidence = "medium"
        elif cached_v_status == "missing_context":
            cached_confidence = "low"
        else:
            cached_confidence = "high" if cached.get("retrievalMode") == "strong" else "low"
        yield _status_sse("writing_answer")
        yield _sse_bytes(json.dumps({
            "meta": True,
            "retrievalMode": cached.get("retrievalMode", "strong"),
            "confidence": cached_confidence,
            "unsupported": cached.get("retrievalMode") != "strong",
            "selectedSourceMode": cached.get("selectedSourceMode"),
            "sourceScope": cached.get("sourceScope"),
            "courseFileScope": cached.get("courseFileScope"),
            "sourceLabel": cached.get("sourceLabel"),
            "sourceDebug": cached.get("sourceDebug") if _source_debug_enabled() else None,
        }))
        cached_answer = cached.get("answer", "")
        for i in range(0, len(cached_answer), 28):
            yield _sse_bytes(json.dumps({"t": cached_answer[i:i + 28]}))
        # Translate Python-shape groundedSources to the JS-frontend shape.
        sources_js = _cached_grounded_sources_to_js(cached.get("groundedSources") or [])
        yield _sse_bytes(json.dumps({
            "done": True,
            "retrievalMode": cached.get("retrievalMode", "strong"),
            "confidence": cached_confidence,
            "verification": cached_v or None,
            "unsupported": cached.get("retrievalMode") != "strong",
            "sources": sources_js,
            "cacheHit": True,
            "model": cached.get("model"),
            "selectedSourceMode": cached.get("selectedSourceMode"),
            "sourceScope": cached.get("sourceScope"),
            "courseFileScope": cached.get("courseFileScope"),
            "sourceLabel": cached.get("sourceLabel"),
            "sourceDebug": cached.get("sourceDebug") if _source_debug_enabled() else None,
        }))

    if (
        cached
        and not payload.responseLanguage
        and not _answer_matches_question_language(question, str(cached.get("answer") or ""))
    ):
        log.warning("ask_stream rejected cached answer with mismatched response language")
        cached = None

    if cached:
        record_retrieval_debug(DebugPayload(
            user_id=user_id, course_id=payload.courseId,
            endpoint="ask-stream", question=question,
            active_document_id=payload.activeDocumentId,
            selected_document_ids=payload.documentIds,
            retrieval_strategy="cache",
            retrieval_mode=cached.get("retrievalMode", "strong"),
            candidate_doc_count=None, exercise_hit=None, chunks=[],
            model=cached.get("model"), cache_hit=True,
            prompt_tokens=cached.get("promptTokens"),
            completion_tokens=cached.get("completionTokens"),
            doc_names=doc_name_map,
        ))
        return StreamingResponse(cached_stream(), media_type="text/event-stream")

    # previous_turns_payload was normalised above (it feeds the cache key too).

    # ── Retrieve ─────────────────────────────────────────────────────────────
    # When the Problem Solver is active, the visible `question` is just a
    # short label ("Problem Solver — Hint mode"). Use the structured problem
    # text for retrieval so embeddings target the actual exercise, not the
    # label. Intentionally exclude `studentWork` from the retrieval query —
    # a student's mistaken equation would pull in irrelevant chunks.
    retrieval_query = (
        (payload.problemSolver.problem or question).strip()
        if payload.problemSolver else resolved_question
    )

    # Follow-up rewriting. A short reply like "I don't know", "yes",
    # "explain that again", "warum?" matches nothing in retrieval and
    # used to land the conversation in PARTIAL mode ("I found a partial
    # match in your course files") — completely breaking the turn-by-turn
    # dialogue. When the new question is short / anaphoric AND we have
    # prior turns, fold the LAST user message into the retrieval query
    # so embeddings target the topic the student is actually following
    # up on. Skip when Problem Solver is active (problemSolver.problem
    # already anchors retrieval to the exercise).
    if not payload.problemSolver and previous_turns_payload:
        q_norm = (question or "").strip()
        # Heuristic: short text OR matches a known stock follow-up phrase.
        _is_short = len(q_norm) <= 25 or len(q_norm.split()) <= 4
        _STOCK_FOLLOWUPS = re.compile(
            r"^(i ?don'?t know|idk|no idea|yes|no|maybe|why\??|warum\??|"
            r"weiter|continue|next|explain (that|this) (again|further|more)|"
            r"solve it|answer it|do it|calculate it|compute it|just answer|"
            r"hm+|ok(ay)?|sure|fine|"
            r"go on|tell me more|more|details?|nochmal|noch einmal|"
            r"i'?m stuck|stuck|help|hilfe|verstehe nicht|don'?t (get|understand)( (it|that))?)\s*[\.!\?]*$",
            re.IGNORECASE,
        )
        _is_anaphoric = bool(_STOCK_FOLLOWUPS.match(q_norm))
        if _is_short or _is_anaphoric:
            last_user = next(
                (t["text"] for t in reversed(previous_turns_payload) if t.get("role") == "user"),
                "",
            )
            if last_user:
                # Prepend the prior user message so retrieval has real
                # signal. Keep the new question on the end so any
                # keywords in it still influence ranking.
                retrieval_query = (last_user + "\n" + q_norm).strip()
    retrieval_query = _augment_retrieval_query_with_open_context(
        question=question,
        retrieval_query=retrieval_query,
        open_file_context=payload.openFileContext,
        has_problem_solver=payload.problemSolver is not None,
    )
    # course_file_scope / retrieval_document_ids resolved above for the cache
    # key; reused here as the retrieval scope.

    # App/product questions ("how do I upload", "where is settings", "what
    # features does Minallo have") should not trigger course-document
    # retrieval. stream_answer's app-question fast path uses
    # MINALLO_APP_CONTEXT only — sending it empty chunks here saves the
    # retrieval cost AND prevents an accidental [Source N] leakage if the
    # model ever ignored its prompt override.
    if app_or_workspace or not dialogue.requires_new_retrieval:
        chunks = []
        exercise_hit = None
        formula_hits = []
    else:
        if status_sink:
            status_sink("identifying_question")
        from ..services.retrieval import retrieve_visible_page_chunks  # noqa: WPS433
        visible_page_chunks = []
        if payload.activeDocumentId and payload.visiblePage:
            visible_page_chunks = await run_in_threadpool(
                lambda: retrieve_visible_page_chunks(
                    user_id=user_id,
                    course_id=payload.courseId,
                    document_id=payload.activeDocumentId,
                    page_number=payload.visiblePage or 1,
                )
            )
        if status_sink:
            status_sink("searching_course_material")
        # Scale retrieval breadth with the number of explicitly-selected
        # documents so multi-file requests ("a question for every lecture",
        # exams) surface material from each one; per-document coverage in
        # retrieve_chunks then guarantees every selected doc is represented.
        _sel_doc_count = len(retrieval_document_ids or [])
        broad_retrieval = generative_request or bool(_BROAD_RETRIEVAL_RE.search(question))
        stream_top_k = _retrieval_limit(question, _sel_doc_count, generative_request)
        retrieval_started = time.perf_counter()
        try:
            exercise_task = run_in_threadpool(
                lambda: retrieve_exercise_block(
                    user_id=user_id, course_id=payload.courseId, query=retrieval_query,
                    document_ids=retrieval_document_ids,
                    active_document_id=payload.activeDocumentId,
                )
            )
            chunks_task = run_in_threadpool(
                lambda: retrieve_chunks(
                    user_id=user_id, course_id=payload.courseId,
                    query=retrieval_query, document_ids=retrieval_document_ids,
                    preferred_document_ids=retrieval_document_ids,
                    active_document_id=payload.activeDocumentId,
                    document_name_query=question,
                    top_k=stream_top_k,
                    # Coverage intent ("a question per file", exams) over an
                    # explicit multi-doc selection: guarantee every selected doc
                    # contributes a candidate so none is silently starved.
                    guarantee_documents=generative_request,
                )
            )
            formula_query = (
                (payload.problemSolver.problem or question).strip()
                if payload.problemSolver else question
            )
            formula_task = run_in_threadpool(
                lambda: retrieve_formula_block(
                    user_id=user_id, course_id=payload.courseId, query=formula_query,
                    document_ids=retrieval_document_ids,
                    active_document_id=payload.activeDocumentId,
                )
            )
            exercise_hit, chunks, formula_hits = await asyncio.gather(
                exercise_task,
                chunks_task,
                formula_task,
            )
        except EmbeddingServiceUnavailable as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
        log.info(
            "ai_stream_timing request_id=%s phase=retrieval retrieval_ms=%.0f top_k=%d broad=%s chunk_count=%d formula_count=%d exercise_hit=%s",
            request_id, (time.perf_counter() - retrieval_started) * 1000,
            stream_top_k, broad_retrieval, len(chunks), len(formula_hits or []), bool(exercise_hit),
        )
        if exercise_hit:
            from .ask import _prepend_exercise_chunks  # reuse the same helper
            chunks = _prepend_exercise_chunks(exercise_hit, chunks)

        if formula_hits:
            from .ask import _prepend_formula_chunks  # reuse the same helper
            chunks = _prepend_formula_chunks(formula_hits, chunks)
        if visible_page_chunks:
            visible_ids = {c.chunk_id for c in visible_page_chunks}
            chunks = visible_page_chunks + [c for c in chunks if c.chunk_id not in visible_ids]
        before_dedup = len(chunks)
        chunks = _deduplicate_chunks(chunks)
        log.info(
            "ai_stream_timing request_id=%s phase=dedup input_chunks=%d output_chunks=%d",
            request_id, before_dedup, len(chunks),
        )

    retrieved_doc_ids = list(dict.fromkeys(
        c.document_id for c in chunks
        if c.document_id and not c.document_id.startswith("__")
    ))
    if retrieved_doc_ids:
        # Defense in depth: RPC filters already include user+course, but verify
        # every document that survived retrieval before its text reaches the
        # model. A buggy/stale RPC can therefore never become a tenant leak.
        verified_retrieved_names = await run_in_threadpool(
            lambda: _verify_user_owns_documents(
                user_id, payload.courseId, retrieved_doc_ids
            )
        )
        doc_name_map.update(verified_retrieved_names)

    missing_ids = [c.document_id for c in chunks if c.document_id not in doc_name_map]
    if missing_ids:
        sb = get_supabase()
        try:
            resp = await run_in_threadpool(
                lambda: sb.table("documents")
                .select("id, file_name")
                .eq("user_id", user_id)
                .eq("course_id", payload.courseId)
                .in_("id", list(set(missing_ids)))
                .execute()
            )
            for row in resp.data or []:
                doc_name_map[row["id"]] = row["file_name"]
        except Exception:
            log.exception("doc_name backfill failed")

    relevance_score = course_relevance_score(question, chunks)
    # Selection→retrieval diagnostic: shows whether the client's file selection
    # actually reached and scoped retrieval, and how many distinct docs the
    # chunks span. Lets us pinpoint a 17-selected → 4-covered drop without
    # guessing. Cheap one-liner; safe to keep.
    log.info(
        "ask_stream selection-diag scope=%s reqIds=%d reqNames=%d resolved=%d chunkDocs=%d relevance=%.3f",
        effective_scope,
        len(payload.documentIds or []),
        len(payload.documentNames or []),
        len(retrieval_document_ids or []),
        len({c.document_id for c in chunks if c.document_id}),
        relevance_score,
    )
    source_decision = replace(
        source_decision,
        relevance_score=relevance_score,
        used_document_ids=list(dict.fromkeys(c.document_id for c in chunks if c.document_id)),
    )
    # The user has committed to grounding on their files when EITHER they picked
    # Course Files mode OR they explicitly selected specific documents (even in
    # Auto mode). In that case any retrieved chunk is a sufficient anchor:
    # command-style requests ("generate an exam from these files", "a question
    # for every lecture") share almost no words with the content, so the
    # relevance gate would otherwise wrongly downgrade them to general knowledge
    # despite an explicit selection. Auto mode WITHOUT a selection keeps the
    # low-relevance downgrade (falls through to a general answer below).
    explicit_course_files = source_decision.selected_source_mode.value == "course_files"
    explicit_selection = bool(retrieval_document_ids)
    has_strong_course_anchor = bool(
        payload.openFileContext or exercise_hit or formula_hits
        or relevance_score >= 0.18
        or ((explicit_course_files or explicit_selection) and chunks)
    )
    # App/workspace questions need no course anchor — they're answered from the
    # product map + live workspace block, not from retrieved chunks. (Without
    # this exemption, "where is settings" with no open PDF used to fall through
    # to a generic general-knowledge answer that never saw the app map.)
    if app_or_workspace or not dialogue.requires_new_retrieval:
        has_strong_course_anchor = True
    if not has_strong_course_anchor:
        if source_decision.selected_source_mode.value == "course_files":
            return _stream_static_answer(
                text=course_not_found_answer(),
                decision=source_decision,
                answer_mode="strong",
                status_key="no_strong_match",
            )
        general_decision = replace(
            source_decision,
            source_scope=SourceScope.GENERAL_KNOWLEDGE,
            source_label="Using: General knowledge",
        )
        general = await run_in_threadpool(lambda: generate_general_answer(question, prefix=auto_general_prefix()))
        record_usage(
            feature="ask_stream_general", model=general.get("model"),
            prompt_tokens=general.get("promptTokens"),
            completion_tokens=general.get("completionTokens"), user_id=user_id,
        )
        return _stream_static_answer(
            text=general["answer"],
            decision=general_decision,
            answer_mode="general",
            model=general.get("model"),
            prompt_tokens=general.get("promptTokens"),
            completion_tokens=general.get("completionTokens"),
            status_key="no_strong_match",
        )

    # ── Stream + save to cache on finish ─────────────────────────────────────
    full_text_buf: list[str] = []
    captured_meta: dict[str, Any] = {}
    pending_token_events: list[bytes] = []
    high_risk_validation = bool(
        open_file_images
        or payload.problemSolver
        or re.search(
            r"\b(calculate|compute|solve|result|how many|marked|checked|selected|"
            r"berechne|bestimme|ermittle|löse|loese|ergebnis|wie viele|"
            r"markiert|angekreuzt)\b",
            question,
            re.IGNORECASE,
        )
    )
    # Usage checkpoint captured from the generator's internal usageEst event
    # (model + estimated prompt tokens, emitted just before the OpenAI call).
    # Consulted by gen_with_abort_meter when the stream dies early.
    abort_meter: dict[str, Any] = {}

    # weak_topics was fetched above (it feeds the workspace block + cache
    # fingerprint as well as the per-student coaching note in the prompt).

    def gen():
        import json
        if app_or_workspace:
            yield _status_sse("checking_app_context")
        elif chunks:
            yield _status_sse("collecting_sources")
        else:
            yield _status_sse("writing_answer")
        if high_risk_validation:
            yield _status_sse("checking_values")
        gen_iter = stream_answer(
            question=question, chunks=chunks, doc_names=doc_name_map,
            tutor_mode=tutor_mode,
            active_file_name=payload.activeFileName,
            open_file_context=payload.openFileContext,
            open_file_images=open_file_images,
            weak_topics=weak_topics,
            previous_turns=previous_turns_payload,
            problem_solver=payload.problemSolver.model_dump() if payload.problemSolver else None,
            workspace_block=workspace_block or None,
            assistant_mode=assistant_mode,
            workspace_question=workspace_question,
            user_id=user_id,
            # The student's selection is the coverage contract for exam /
            # per-file requests — pass the resolved names so every selected file
            # gets a section and any still-processing ones are reported. The ids
            # also anchor exam-style detection to the real selection, not just
            # whatever chunks retrieval happened to surface.
            selected_file_names=[
                doc_name_map[i] for i in (retrieval_document_ids or []) if i in doc_name_map
            ] or None,
            selected_document_ids=list(retrieval_document_ids) if retrieval_document_ids else None,
            request_id=request_id,
            response_language=language_context.requested_response_language,
            dialogue_overlay=dialogue.prompt_overlay(),
        )
        for chunk_bytes in gen_iter:
            # Decode the SSE event so we can intercept the closing 'done' frame.
            try:
                line = chunk_bytes.decode("utf-8").lstrip().removeprefix("data: ").rstrip()
                evt = json.loads(line)
            except Exception:
                yield chunk_bytes
                continue
            if isinstance(evt, dict):
                if evt.get("usageEst"):
                    # Internal abort-metering checkpoint — capture, never
                    # forward to the client. "cancel" retracts it (the OpenAI
                    # call failed before any token, so nothing was billed).
                    if evt.get("cancel"):
                        abort_meter.clear()
                    else:
                        abort_meter["model"] = evt.get("model")
                        abort_meter["promptTokens"] = int(evt.get("estPromptTokens") or 0)
                    continue
                if evt.get("meta"):
                    evt["dialogueResolution"] = dialogue.to_api()
                    evt.update(_source_meta(source_decision, cache_hit=False))
                    chunk_bytes = ("data: " + json.dumps(evt, ensure_ascii=False) + "\n\n").encode("utf-8")
                if evt.get("t"):
                    full_text_buf.append(evt["t"])
                    if high_risk_validation:
                        pending_token_events.append(chunk_bytes)
                        continue
                if evt.get("done"):
                    evt["dialogueResolution"] = dialogue.to_api()
                    verification_payload = evt.get("verification")
                    critical_reject = _verification_requires_rejection(verification_payload)
                    if high_risk_validation and critical_reject:
                        safe_text = recovery_message(
                            "critical_numerical_mismatch",
                            language_context.requested_response_language,
                        )
                        full_text_buf.clear()
                        full_text_buf.append(safe_text)
                        pending_token_events.clear()
                        yield _sse_bytes(json.dumps({"t": safe_text}, ensure_ascii=False))
                        evt["answerMode"] = "verification_rejected"
                        evt["confidence"] = "low"
                        evt["unsupported"] = True
                        evt["recovery"] = {
                            "code": "critical_numerical_mismatch",
                            "action": "report_missing_evidence",
                        }
                    elif high_risk_validation:
                        for pending in pending_token_events:
                            yield pending
                        pending_token_events.clear()
                    captured_meta.update(evt)
                    record_usage(
                        feature="ask_stream",
                        model=evt.get("model"),
                        prompt_tokens=evt.get("promptTokens"),
                        completion_tokens=evt.get("completionTokens"),
                        cached_tokens=evt.get("cachedTokens"),
                        user_id=user_id,
                    )
                    # Translate sources for the JS frontend shape (mirrors
                    # the cached-stream branch above).
                    sources_js = []
                    for s in (evt.get("sources") or []):
                        page_start = s.get("pageStart") if isinstance(s, dict) else None
                        page_end = s.get("pageEnd") if isinstance(s, dict) else None
                        pages = s.get("pages") if isinstance(s, dict) else None
                        if not pages and page_start and page_end:
                            pages = str(page_start) if page_start == page_end else f"{page_start}-{page_end}"
                        elif not pages and page_start:
                            pages = str(page_start)
                        sources_js.append({
                            "file_name": s.get("file_name") or s.get("fileName") or "Unknown",
                            "pages": pages,
                            "section": s.get("section") or s.get("sectionTitle"),
                            # documentId + pageStart let the frontend open the
                            # cited PDF by id (robust against mangled file
                            # names) at the right page.
                            "documentId": s.get("documentId") or s.get("document_id"),
                            "pageStart": page_start,
                        })
                    evt["sources"] = sources_js
                    evt["cacheHit"] = False
                    evt.update(_source_meta(source_decision, cache_hit=False))
                    chunk_bytes = ("data: " + json.dumps(evt, ensure_ascii=False) + "\n\n").encode("utf-8")
            yield chunk_bytes

        # After the generator finishes, persist to cache. Heavy-capped answers
        # are not cached: they came from the downgraded model and carry the
        # allowance notice in the token stream — replaying either next month
        # (or to the same user mid-month) would be wrong.
        cached_verification = captured_meta.get("verification")
        cache_verified = _verification_is_cacheable(cached_verification)
        if (
            version_hash
            and full_text_buf
            and cache_verified
            and not captured_meta.get("heavyCapped")
            and not captured_meta.get("recovery")
        ):
            from ..services.request_generation import is_current_generation  # noqa: WPS433
            if not is_current_generation(
                user_id, payload.conversationId, payload.conversationGeneration
            ):
                log.info(
                    "stale_generation_cache_blocked request_id=%s conversation_hash=%s generation=%s",
                    request_id,
                    hashlib.sha256((payload.conversationId or "").encode()).hexdigest()[:12],
                    payload.conversationGeneration,
                )
                return
            persistence_started = time.perf_counter()
            try:
                save_answer(
                    user_id=user_id, course_id=payload.courseId,
                    question=question, version_hash=version_hash,
                    answer_json={
                        "answer": "".join(full_text_buf),
                        "retrievalMode": captured_meta.get("retrievalMode", "strong"),
                        # Review-2 finding #7 (also follow-up nit): persist
                        # verification + confidence so cached replays carry
                        # the same confidence label the original answer
                        # earned. Also persist answerMode (math|strong|
                        # partial|weak) and tutorMode (explain|solve|quiz)
                        # so the cached UI badge + downstream consumers see
                        # the same mode classification.
                        "verification": captured_meta.get("verification"),
                        "confidence":   captured_meta.get("confidence"),
                        "answerMode":   captured_meta.get("answerMode"),
                        "tutorMode":    captured_meta.get("tutorMode"),
                        "groundedSources": [
                            {
                                "fileName": s.get("file_name"),
                                "documentId": s.get("documentId") or s.get("document_id"),
                                "pageStart": s.get("pageStart"),
                                "pageEnd": s.get("pageEnd"),
                                "sectionTitle": s.get("section"),
                                "pages": s.get("pages"),
                                "index": s.get("index"),
                            }
                            for s in (captured_meta.get("sources") or [])
                        ],
                        "model": captured_meta.get("model"),
                        "promptTokens": captured_meta.get("promptTokens"),
                        "completionTokens": captured_meta.get("completionTokens"),
                        "selectedSourceMode": captured_meta.get("selectedSourceMode"),
                        "sourceScope": captured_meta.get("sourceScope"),
                        "courseFileScope": captured_meta.get("courseFileScope"),
                        "sourceLabel": captured_meta.get("sourceLabel"),
                        "sourceDebug": captured_meta.get("sourceDebug") if _source_debug_enabled() else None,
                    },
                    # Same key args as the lookup — symmetry is mandatory or the
                    # saved row is never found on the next request.
                    **cache_key_kwargs,
                )
            except Exception:
                log.exception("cache save after stream failed (non-fatal)")
            finally:
                log.info(
                    "ai_stream_timing request_id=%s phase=persistence persistence_ms=%.0f",
                    request_id, (time.perf_counter() - persistence_started) * 1000,
                )

        record_retrieval_debug(DebugPayload(
            user_id=user_id, course_id=payload.courseId,
            endpoint="ask-stream", question=question,
            active_document_id=payload.activeDocumentId,
            selected_document_ids=payload.documentIds,
            retrieval_strategy=(
                "+".join(
                    (["exercise-exact"] if exercise_hit else [])
                    + (["formula-exact"] if formula_hits else [])
                    + ["vector+bm25"]
                )
            ),
            retrieval_mode=captured_meta.get("retrievalMode"),
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
            exact_hits={
                "exercise": (
                    {
                        "documentId": exercise_hit.document_id,
                        "exerciseNumber": exercise_hit.exercise_number,
                        "subpart": exercise_hit.subpart,
                        "pageStart": exercise_hit.page_start,
                        "pageEnd": exercise_hit.page_end,
                    } if exercise_hit else None
                ),
                "formulas": [
                    {
                        "documentId": h.document_id,
                        "formulaName": h.formula_name,
                        "symbols": h.symbols,
                        "pageNumber": h.page_number,
                    }
                    for h in (formula_hits or [])
                ],
            },
            chunks=chunks,
            model=captured_meta.get("model"), cache_hit=False,
            prompt_tokens=captured_meta.get("promptTokens"),
            completion_tokens=captured_meta.get("completionTokens"),
            doc_names=doc_name_map,
        ))

    def gen_with_abort_meter():
        try:
            yield from gen()
        finally:
            # The done frame never arrived: the client aborted mid-answer (or
            # the stream died after generation started). OpenAI billed the
            # full prompt the moment the request landed plus whatever
            # completion streamed — record the estimate so real spend doesn't
            # vanish from the meter. ~chars/4; tagged ask_stream_aborted so
            # estimated rows are distinguishable from exact ones.
            if abort_meter.get("model") and not captured_meta.get("done"):
                record_usage(
                    feature="ask_stream_aborted",
                    model=abort_meter.get("model"),
                    prompt_tokens=abort_meter.get("promptTokens"),
                    completion_tokens=len("".join(full_text_buf)) // 4,
                    user_id=user_id,
                )

    return StreamingResponse(gen_with_abort_meter(), media_type="text/event-stream")

"""POST /ask-stream — SSE-streamed RAG answer for the browser.

Browser hits this directly with the Supabase JWT in the Authorization
header. We verify the JWT against Supabase's auth API, then stream
tokens as they arrive from OpenAI. This bypasses Netlify entirely, so
the 30s function timeout never applies.

Reuses /ask's retrieval + ownership + cache logic.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import json
import re
import time
import unicodedata
import urllib.parse
import uuid
from dataclasses import asdict, dataclass, replace
from types import SimpleNamespace
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

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
from ..services.execution_router import (
    EscalationReason,
    ExecutionLane,
    fast_grounded_evidence_is_sufficient,
    resolve_execution_plan,
)
from ..services.grounding_contract import (
    GroundingRequest,
    GroundingResolution,
    RequestedDocumentAccess,
    ResolvedDocumentAccess,
    ViewerContext,
    resolve_document_access,
    select_processing_pipeline,
    grounding_cache_payload,
)
from ..services.index_manifest import validate_page_manifest
from ..services.learning_recommendation import (
    build_explanation_plan,
    build_learning_recommendations,
)
from ..services.deep_learn_reuse import course_revision_hash, find_existing_lesson
from ..services.visual_aids import VisualContext, select_visual_aids
from ..services.fallback_research import research_unresolved_items
from ..services.multi_item_retrieval import (
    answer_plan_overlay,
    ensure_complete_answer,
    retrieve_multi_item_course_evidence,
)
from ..services.course_grounding import (
    assert_authorised_course_chunks,
    build_course_evidence_report,
    rank_course_chunks,
)
from ..services.retrieval import (
    find_numbered_section_reference,
    retrieve_chunks,
    retrieve_routed_chunks,
    retrieve_exercise_block,
    retrieve_formula_block,
    retrieve_numbered_section_chunks,
)
from ..services.retrieval_debug import DebugPayload, record_retrieval_debug
from ..services.reliability import (
    GroundedRequestContext,
    assess_text_quality,
    classify_task_traits,
    derive_grounding_state,
    evidence_requirement,
    identity_is_sufficient,
    is_page_bound_request,
    merge_grounded_task_identity,
)
from ..services.source_router import (
    CourseFileScope,
    SourceDecision,
    SourceScope,
    auto_general_prefix,
    classify_source_scope,
    course_not_found_answer,
    course_relevance_score,
    effective_document_ids,
    policy_allows_general_knowledge,
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
_INNER_STREAM_HEARTBEAT_SECONDS = 10.0
# A heartbeat proves the coroutine is alive, not that useful work is advancing.
# Focused (non-leased) responses therefore get an absolute per-stage deadline;
# exhaustive scoped jobs use their database lease/worker recovery instead.
_FOCUSED_RESPONSE_STAGE_TIMEOUT_SECONDS = 240.0
_MAX_STREAM_OPEN_FILE_CTX_CHARS = 20000
_MAX_OPEN_FILE_IMAGES = 3
_MAX_OPEN_FILE_IMAGE_BASE64_CHARS = 2_500_000
_ALLOWED_OPEN_FILE_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
_FALSE_VISUAL_DENIAL_RE = re.compile(
    r"\b(?:cannot see|can't see|could not see|please open the pdf|open the page|"
    r"upload the (?:image|page|diagram)|paste the (?:formula|equation|text)|"
    r"formula (?:is|was) not provided|diagram (?:is|was) missing)\b",
    re.IGNORECASE,
)
# Mirror backend/lib/rate-limit.ts INTERACTIVE_MONTHLY_CAP. /ask-stream is an
# interactive RAG call (cheap per request on gpt-4o-mini) so it lives in the
# interactive bucket alongside /api/ai/ask and the writing coach.
_INTERACTIVE_MONTHLY_CAP = 2000


def _automatic_context_conversation_id(payload: "AskStreamRequest") -> str:
    """Stable server-owned tutoring section for clients with local-only chats."""
    document_keys = sorted(set(
        [str(item) for item in (payload.documentIds or []) if item]
        + [str(item).strip().casefold() for item in (payload.documentNames or []) if item]
        + ([str(payload.activeDocumentId)] if payload.activeDocumentId else [])
    ))
    scope = (
        "document" if len(document_keys) == 1
        else "document_set" if document_keys
        else "course" if payload.courseId
        else "global"
    )
    raw = json.dumps({
        "courseId": payload.courseId or None,
        "documentKeys": document_keys,
        "scope": scope,
    }, sort_keys=True, ensure_ascii=False)
    return "autoctx:" + hashlib.sha256(raw.encode()).hexdigest()[:32]

_BROAD_RETRIEVAL_RE = re.compile(
    r"\b(rest|remaining|continuation|fortsetzung|restlichen)\b|"
    r"\b\d+(?:\.\d+)?\s*(?:to|bis|-|â€“|â€”|and)\s*\d+(?:\.\d+)?\b|"
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


def _load_authorized_documents(
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
) -> dict[str, dict[str, Any]]:
    if not document_ids:
        return {}
    sb = get_supabase()
    unique_ids = list(dict.fromkeys(document_ids))
    resp = (
        sb.table("documents")
        .select(
            "id, user_id, course_id, file_name, storage_path, document_hash, "
            "processing_status, page_count, chunk_count, updated_at, active_index_revision, "
            "structural_index_status"
        )
        .in_("id", unique_ids)
        .execute()
    )
    rows = resp.data or []
    if len(rows) != len(unique_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    for row in rows:
        if row["user_id"] != user_id or row["course_id"] != course_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    return {row["id"]: row for row in rows}


def _load_authorized_course_candidates(user_id: str, course_id: str) -> list[dict[str, Any]]:
    """List only the authenticated user's course documents for scope selection."""
    rows = (
        get_supabase().table("documents")
        .select("id, file_name, user_id, course_id, active_index_revision")
        .eq("user_id", user_id).eq("course_id", course_id).limit(100).execute()
    ).data or []
    # Defense in depth if a future client/query abstraction drops a filter.
    return [row for row in rows if row.get("user_id") == user_id and row.get("course_id") == course_id]


def _load_canonical_manifest(row: dict[str, Any]) -> list[Any]:
    """Load and validate the canonical page manifest for a document's active
    revision. Validates against the document's own AUTHORITATIVE expected
    page count (page_count, written at the same moment this exact revision
    was activated) — never against len(manifest_rows) itself, which would
    let a truncated manifest (e.g. 93 rows when 100 were expected) validate
    against its own row count instead of the real expectation."""
    revision = str(row.get("active_index_revision") or "")
    if not revision:
        raise ValueError("missing active index revision")
    manifest_rows = (
        get_supabase().table("document_page_manifests")
        .select("page_number, source_page_id, required_for_processing, status, exclusion_reason")
        .eq("document_id", row["id"]).eq("index_revision", revision)
        .order("page_number").execute()
    ).data or []
    expected_pages = int(row.get("page_count") or 0)
    return validate_page_manifest(manifest_rows, physical_page_count=expected_pages)


def _selected_document_readiness_issue(row: dict[str, Any]) -> str | None:
    """Return the precise readiness defect for an explicitly selected source."""
    status_value = str(row.get("processing_status") or "not_ready").casefold()
    if status_value != "ready":
        return status_value
    try:
        page_count = int(row.get("page_count") or 0)
        chunk_count = int(row.get("chunk_count") or 0)
    except (TypeError, ValueError):
        return "invalid_index_metadata"
    if page_count <= 0:
        return "missing_pages"
    if chunk_count <= 0:
        return "missing_chunks"
    # Documents indexed before revisioned swaps have no active revision, but
    # their ready chunks remain valid retrieval input. Rejecting those rows
    # here made every ordinary question fail until an unnecessary full
    # reindex. Revision-sensitive exhaustive jobs already derive a stable
    # fallback from document_hash/updated_at downstream.
    revision_status = str(
        row.get("index_revision_status")
        or row.get("structural_index_status")
        or ""
    ).casefold()
    if (
        not str(row.get("active_index_revision") or "").strip()
        and revision_status not in {"legacy", "structural_reindex_required"}
    ):
        return "missing_active_revision"
    return None


def _selected_document_index_corrupt(row: dict[str, Any]) -> bool:
    """Second-layer LIVE check for a row that already passed the cheap cached
    check above. ``processing_status='ready'`` plus a non-zero cached
    ``chunk_count`` are not proof a document is actually retrievable — those
    counters can drift from the real document_chunks/document_pages rows
    (see ``services.document_health`` for the incident that surfaced this:
    25 documents sitting at 'ready' with a stale chunk_count but zero live
    chunks). Kept separate from ``_selected_document_readiness_issue`` so
    that function's cheap, pure, well-tested metadata check is untouched;
    this one does real I/O and is only worth paying for once a row already
    looks ready."""
    from ..services.document_health import (  # noqa: WPS433
        DocumentIndexHealth,
        validate_active_document_index,
    )

    health = validate_active_document_index(str(row.get("id") or ""))
    return health.get("health") in (
        DocumentIndexHealth.STALE_METADATA,
        DocumentIndexHealth.MISSING_CHUNKS,
        DocumentIndexHealth.MISSING_PAGES,
        DocumentIndexHealth.MANIFEST_INVALID,
        DocumentIndexHealth.REVISION_INCONSISTENT,
    )


def _verify_user_owns_documents(
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
) -> dict[str, str]:
    return {
        document_id: str(row.get("file_name") or "")
        for document_id, row in _load_authorized_documents(
            user_id, course_id, document_ids
        ).items()
    }


def _resolve_document_names(
    user_id: str,
    course_id: str,
    names: list[str] | None,
) -> dict[str, Any]:
    """Resolve each requested filename without losing partial failures."""
    clean = list(dict.fromkeys(n.strip() for n in (names or []) if n and n.strip()))[:50]
    result: dict[str, Any] = {
        "requested_names": clean,
        "resolved_ids": [],
        "unresolved_names": [],
        "ambiguous_candidates": [],
    }
    if not clean:
        return result
    sb = get_supabase()
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
        result["unresolved_names"] = clean
        return result

    def _norm(value: str) -> str:
        # Mirrors the frontend's normalizeDocumentFileName (document-type-
        # badge.ts): URL-decode, take the last path segment (both separators
        # — a full path or a mixed-slash upload path can slip through),
        # Unicode-normalise (NFKC — otherwise a composed vs. decomposed
        # accented character silently fails to match), then strip whichever
        # of the supported extensions is present before casefolding.
        value = (value or "").strip()
        try:
            value = urllib.parse.unquote(value)
        except Exception:  # noqa: BLE001
            pass
        value = value.replace("\\", "/").rsplit("/", 1)[-1]
        value = unicodedata.normalize("NFKC", value).casefold()
        return re.sub(r"\.(?:pdf|docx?|txt|pptx?)$", "", value)

    rows = [
        {"id": str(row.get("id") or ""), "name": str(row.get("file_name") or "")}
        for row in (resp.data or [])
        if row.get("id")
    ]
    for requested_name in clean:
        matches = [row for row in rows if _norm(row["name"]) == _norm(requested_name)]
        if len(matches) == 1:
            result["resolved_ids"].append(matches[0]["id"])
        elif not matches:
            result["unresolved_names"].append(requested_name)
        else:
            result["ambiguous_candidates"].extend(
                {**candidate, "requestedName": requested_name}
                for candidate in matches
            )
    result["resolved_ids"] = list(dict.fromkeys(result["resolved_ids"]))
    return result


def _resolve_document_ids_by_name(user_id: str, course_id: str, names: list[str] | None) -> list[str]:
    """Resolve storage file names → owned document ids in this course.

    The chatbot's "Selected file(s)" scope only knows file names (the document
    id lives server-side), so it sends names; this maps them to ids for scoped
    retrieval. Returns [] on error or no match; callers must return a typed
    source-resolution result and must never broaden the scope silently."""
    return list(_resolve_document_names(user_id, course_id, names)["resolved_ids"])


class PreviousTurn(BaseModel):
    """One prior question/answer pair from the same chat session.
    The streaming endpoint accepts a short list of these so the model can
    resolve follow-up references like "the formula above" or "explain
    the same thing in simpler terms" without re-running retrieval."""
    role: str = Field(max_length=20)   # "user" | "assistant"
    # _trim_previous_turns further truncates each turn to 1200 chars and the
    # whole list to 30 entries — this is just a schema-level ceiling so an
    # oversized payload is rejected before any of that trimming work runs.
    text: str = Field(max_length=20000)


class ProblemSolverPayload(BaseModel):
    mode: str = Field(max_length=40)
    problem: str = Field(max_length=20000)
    studentWork: str | None = Field(default=None, max_length=20000)


class OpenFileImagePayload(BaseModel):
    mediaType: str = "image/jpeg"
    data: str
    page: int | None = None
    region: str = "full_page"


class VisualContextMeta(BaseModel):
    renderAttempted: bool = False
    renderedPage: int | None = None
    renderedImageCount: int = 0
    currentPageTextChars: int = 0
    activeDocumentId: str | None = None
    activeFileName: str | None = None
    snapshotId: str | None = None
    pageTextStatus: str | None = None
    capturedImagePages: list[int] = Field(default_factory=list)


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
    coordinateSpace: str | None = None
    pageRotation: int | None = None
    cropBox: list[float] | None = None
    mediaBox: list[float] | None = None
    pdfBoundingBox: list[float] | None = None


class AskStreamRequest(BaseModel):
    courseId: str = Field(max_length=200)
    # _require_uuid validates each entry is a real UUID below; max_length here
    # bounds the LIST (how many ids a single request can name), not one id's
    # length — matching _resolve_document_names' own 50-name cap so an
    # oversized payload is rejected before any resolution work runs.
    documentIds: list[str] | None = Field(default=None, max_length=50)
    # "Selected file(s)" scope from the chatbot, which only knows storage file
    # NAMES (the document id lives server-side). Resolved to document ids here.
    documentNames: list[str] | None = Field(default=None, max_length=50)
    activeDocumentId: str | None = None
    activePdfVisible: bool = False
    question: str
    # The file name + a slice of text from whatever the user is currently
    # looking at in the PDF reader. Surfaced into the user message so the
    # model can ground "this question / this section" references even when
    # retrieval doesn't surface the exact chunk. Both optional.
    activeFileName: str | None = Field(default=None, max_length=500)
    visiblePage: int | None = None
    selectedText: str | None = None
    selectedRegion: SelectedRegionPayload | None = None
    viewerRevision: str | None = Field(default=None, max_length=200)
    conversationId: str | None = None
    durableConversation: bool = False
    clientMessageId: str | None = Field(default=None, min_length=1, max_length=160)
    assistantMessageId: str | None = Field(default=None, min_length=1, max_length=160)
    requestId: str | None = Field(default=None, min_length=8, max_length=128)
    requestSnapshot: dict[str, Any] | None = None
    conversationGeneration: int | None = Field(default=None, ge=0)
    responseLanguage: str | None = Field(default=None, max_length=40)
    openFileContext: str | None = None
    openFileImages: list[OpenFileImagePayload] | None = Field(default=None, max_length=3)
    visualEvidenceExpected: bool = False
    visualUpload: bool = False
    visualContextMeta: VisualContextMeta | None = None
    # Tutor-mode overlay: explain | solve | quiz. Defaults to 'explain'.
    tutorMode: str | None = Field(default=None, max_length=40)
    sourceMode: str | None = Field(default="auto", max_length=40)
    courseFileScope: str | None = Field(default="all_course_files", max_length=40)
    # New additive contract.  Legacy fields above remain accepted for one
    # compatibility cycle and are normalised into this shape at preflight.
    groundingRequest: GroundingRequest | None = None
    visiblePageContext: str | None = None
    # Recent transcript for this file-scoped chat, newest last. The answer
    # service enforces per-turn, message-count, and total-character caps;
    # max_length here just bounds the list itself, generously above the 30
    # entries actually used (_MAX_HISTORY_MESSAGES in answer_stream.py), so
    # an oversized payload is rejected before any trimming work runs.
    previousTurns: list[PreviousTurn] | None = Field(default=None, max_length=200)
    problemSolver: ProblemSolverPayload | None = None
    # Current UI location (page / course tab / open document title). Optional;
    # sanitised server-side. Lets the assistant answer "where am I, what can I
    # do here" and point at the right course tab.
    pageContext: PageContextPayload | None = None
    # bypassCache is intentionally NOT exposed on the public API. The cache
    # is keyed by document_version_hash so it invalidates automatically when
    # documents change; letting the client opt out defeats the single biggest
    # cost mitigation. Any field the client sends is ignored.

    @field_validator("requestSnapshot")
    @classmethod
    def _bound_request_snapshot_size(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        # requestSnapshot is meant to be a small resend of this chat's own
        # settings (source mode, scope, selected ids, course id) — not
        # arbitrary client data. Reject anything implausibly large rather
        # than doing unbounded JSON work on it downstream.
        if value is not None and len(json.dumps(value, ensure_ascii=False)) > 20_000:
            raise ValueError("requestSnapshot is too large")
        return value


class EnsureConversationRequest(BaseModel):
    clientConversationId: str = Field(min_length=1, max_length=160)
    courseId: str | None = None
    activeDocumentId: str | None = None
    titleSeed: str | None = Field(default=None, max_length=180)
    clientMessageId: str | None = Field(default=None, max_length=160)
    messageText: str | None = Field(default=None, max_length=_MAX_STREAM_QUESTION_CHARS)
    assistantMessageId: str | None = Field(default=None, max_length=160)
    requestId: str | None = Field(default=None, min_length=8, max_length=128)
    requestSnapshot: dict[str, Any] | None = None


def _sse_bytes(payload: str) -> bytes:
    return ("data: " + payload + "\n\n").encode("utf-8")


def _status_sse(status_key: str) -> bytes:
    return _sse_bytes(json.dumps({"status": status_key}, ensure_ascii=False))


def _commentary_sse(event: dict[str, Any]) -> bytes:
    return _sse_bytes(json.dumps(event, ensure_ascii=False))


class TutorPipelineError(Exception):
    def __init__(self, *, code: str, stage: str, message: str, retryable: bool,
                 recoverable: bool, metadata: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.retryable = retryable
        self.recoverable = recoverable
        self.metadata = metadata or {}


def _error_sse(*, code: str, message: str, retryable: bool, request_id: str,
               stage: str = "unknown", recoverable: bool | None = None,
               partial_answer_available: bool = False,
               metadata: dict[str, Any] | None = None) -> bytes:
    return _sse_bytes(json.dumps({
        "type": "error",
        "error": True,
        "code": code,
        "message": message,
        "retryable": retryable,
        "recoverable": retryable if recoverable is None else recoverable,
        "stage": stage,
        "partialAnswerAvailable": partial_answer_available,
        "metadata": metadata or {},
        "requestId": request_id,
    }, ensure_ascii=False))


def _is_terminal_sse(event: bytes | str) -> bool:
    raw = event.decode("utf-8", errors="ignore") if isinstance(event, bytes) else event
    return bool(re.search(r'"(?:done|error)"\s*:\s*true', raw))


@dataclass(frozen=True)
class VerificationRejection:
    reject: bool
    code: str | None = None
    reasons: tuple[str, ...] = ()


def verification_rejection(
    verification: Any,
    *,
    task_type: str = "standard_qa",
) -> VerificationRejection:
    if not isinstance(verification, dict):
        return VerificationRejection(False)
    details = verification.get("details")
    if not isinstance(details, dict):
        return VerificationRejection(False)
    fatal_checks = (
        ("fabricated_filenames", details.get("fabricatedFilenames")),
        ("invalid_source_indices", details.get("invalidSourceIndices")),
        ("fake_solution_phrases", details.get("fakeSolutionPhrases")),
        ("critical_numerical_mismatch", details.get("criticalNumericalMismatch")),
    )
    fatal = tuple(code for code, present in fatal_checks if present)
    advisory = ()
    if details.get("numberMisses"):
        advisory = ("unverified_numbers_advisory",)
    return VerificationRejection(
        bool(fatal),
        code=fatal[0] if fatal else None,
        reasons=(*fatal, *advisory),
    )


def _verification_requires_rejection(
    verification: Any,
    *,
    task_type: str = "standard_qa",
) -> bool:
    return verification_rejection(
        verification,
        task_type=task_type,
    ).reject


def _verification_is_cacheable(
    verification: Any,
    *,
    task_type: str = "standard_qa",
    task_identity=None,
) -> bool:
    return bool(
        isinstance(verification, dict)
        and verification.get("status") == "verified"
        and (
            task_identity is None
            or float(getattr(task_identity, "source_confidence", 0.0)) >= 0.72
        )
        and not _verification_requires_rejection(
            verification,
            task_type=task_type,
        )
    )


def _requires_verified_buffering(
    *,
    question: str,
    dialogue_act: str,
    has_visual_evidence: bool,
    has_active_numerical_state: bool,
    source_conflict: bool = False,
    task_traits=None,
) -> bool:
    """Classify safety from resolved intent and context, not language keywords."""
    if task_traits is not None:
        return bool(
            task_traits.requires_pre_display_verification
            or task_traits.requires_numerical_validation
            or source_conflict
        )
    high_risk_acts = {
        "correct_assistant", "reject_answer", "verify_previous_answer",
        "check_answer", "request_result_only", "reuse_verified_result",
        "continue_next_question", "continue_from_step", "answer_all_requested",
    }
    formula_or_number = bool(re.search(
        r"(?:\d|=|[+\-*/^]|\\(?:frac|sqrt|sum|int)|[²³√∑∫])",
        question or "",
    ))
    short_symbolic_followup = bool(
        len((question or "").split()) <= 5
        and re.search(r"\b[A-Za-z][A-Za-z0-9_]{0,2}\s*[?.!]*$", question or "")
    )
    return bool(
        has_visual_evidence
        or has_active_numerical_state
        or source_conflict
        or dialogue_act in high_risk_acts
        or formula_or_number
        or short_symbolic_followup
    )


def _selection_is_stale(
    region: SelectedRegionPayload | None,
    *,
    visible_page: int | None,
    viewer_revision: str | None,
) -> bool:
    if not region:
        return False
    wrong_revision = bool(
        region.documentRevision
        and viewer_revision
        and region.documentRevision != viewer_revision
    )
    wrong_page = visible_page is not None and region.page != visible_page
    return wrong_revision or wrong_page


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
        needs_clarification = answer_mode == "clarification"
        used_general_knowledge = answer_mode == "general"
        unsupported = needs_clarification
        yield _status_sse(status_key)
        meta = {
            "meta": True,
            "retrievalMode": decision.source_scope.value,
            "answerMode": answer_mode,
            "confidence": confidence,
            "unsupported": unsupported,
            "needsClarification": needs_clarification,
            "usedGeneralKnowledge": used_general_knowledge,
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
            "needsClarification": needs_clarification,
            "usedGeneralKnowledge": used_general_knowledge,
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
        region = (img.region or "full_page").strip().lower()
        if region not in {
            "full_page", "selected_region", "formula_area", "drawing_area", "answer_grid",
        }:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="unsupported image region")
        normalised.append({
            "mediaType": media_type,
            "data": data,
            "page": img.page,
            "region": region,
        })
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


@router.post("/conversations/ensure")
async def ensure_conversation_endpoint(
    payload: EnsureConversationRequest,
    user: dict = Depends(verify_supabase_jwt),
):
    """Idempotently persist a browser chat and its current user turn."""
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")
        await run_in_threadpool(
            lambda: _verify_user_owns_documents(
                user["id"], payload.courseId or "", [payload.activeDocumentId],
            )
        )
    from ..services.conversation_store import (  # noqa: WPS433
        create_durable_tutor_turn,
        ensure_durable_conversation,
    )
    from ..services.tutor_state_store import claim_generation  # noqa: WPS433

    turn_fields = (
        payload.clientMessageId, payload.messageText,
        payload.assistantMessageId, payload.requestId,
    )
    if any(turn_fields) and not all(turn_fields):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "incomplete_durable_tutor_turn", "retryable": False},
        )
    atomic_turn = all(turn_fields)
    try:
        durable = await run_in_threadpool(
            lambda: ensure_durable_conversation(
                user_id=user["id"],
                client_conversation_id=payload.clientConversationId,
                course_id=payload.courseId,
                active_document_id=payload.activeDocumentId,
                title_seed=payload.titleSeed,
                client_message_id=None if atomic_turn else payload.clientMessageId,
                message_text=None if atomic_turn else payload.messageText,
            )
        )
        # Creating the durable conversation also guarantees an empty tutor
        # state exists. Repeated calls are safe and preserve generation 0.
        accepted = await run_in_threadpool(
            lambda: claim_generation(
                user["id"], durable.conversation_id, payload.courseId or "", 0,
            )
        )
        if not accepted:
            raise RuntimeError("initial tutor state was not accepted")
        if atomic_turn:
            await run_in_threadpool(lambda: create_durable_tutor_turn(
                user_id=user["id"], conversation_id=durable.conversation_id,
                user_message_id=payload.clientMessageId or "",
                user_content=payload.messageText or "",
                assistant_message_id=payload.assistantMessageId or "",
                request_id=payload.requestId or "",
                request_snapshot=payload.requestSnapshot or {},
            ))
    except Exception as exc:
        log.exception("durable_conversation_creation_failed user=%s", user["id"])
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "tutor_state_creation_failed",
                "message": "Minallo could not save the document-scan progress.",
                "retryable": True,
            },
        ) from exc
    return {"conversationId": durable.conversation_id, "created": durable.created}


@router.get("/conversations/{conversation_id}/messages")
async def conversation_messages_endpoint(
    conversation_id: str,
    user: dict = Depends(verify_supabase_jwt),
):
    """Return the authoritative transcript used to repair refresh-time cache loss."""
    _require_uuid(conversation_id, "conversationId")
    from ..services.conversation_store import get_durable_conversation_messages  # noqa: WPS433
    rows = None
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            rows = await run_in_threadpool(lambda: get_durable_conversation_messages(
                user_id=user["id"], conversation_id=conversation_id,
            ))
            break
        except Exception as exc:  # transient Supabase HTTP/2 disconnects are retryable
            last_error = exc
            if attempt == 0:
                await asyncio.sleep(0.15)
    if rows is None:
        log.warning("durable_transcript_hydration_failed conversation=%s error=%s",
                    conversation_id, type(last_error).__name__)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail={
            "code": "transcript_hydration_unavailable", "retryable": True,
        }) from last_error
    revision = hashlib.sha256(json.dumps([
        [row.get("client_message_id"), row.get("updated_at"), row.get("completion_state"),
         len(str(row.get("content") or "")), row.get("request_id"), row.get("scoped_job_id")]
        for row in rows
    ], sort_keys=True, default=str).encode("utf-8")).hexdigest()
    return {"messages": rows, "revision": revision}


@router.get("/requests/{request_id}")
async def tutor_request_status_endpoint(
    request_id: str,
    user: dict = Depends(verify_supabase_jwt),
):
    """Return durable request state so a disconnected browser can reconcile."""
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid request id")
    from ..services.conversation_store import (  # noqa: WPS433
        expire_stale_tutor_request, get_tutor_request,
    )
    record = await run_in_threadpool(
        lambda: get_tutor_request(user_id=user["id"], request_id=request_id)
    )
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={
            "code": "request_state_not_found", "retryable": True,
        })
    record = await run_in_threadpool(lambda: expire_stale_tutor_request(
        user_id=user["id"], record=record,
    ))
    return record


@router.get("/scoped-jobs/{job_id}")
async def scoped_job_status_endpoint(
    job_id: str,
    user: dict = Depends(verify_supabase_jwt),
):
    """Authoritative refresh/reconnect snapshot for an exhaustive job."""
    _require_uuid(job_id, "job_id")
    from ..services.scoped_job_store import load_job_snapshot  # noqa: WPS433
    snapshot = await run_in_threadpool(
        lambda: load_job_snapshot(user_id=user["id"], job_id=job_id)
    )
    if not snapshot:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "scoped_job_not_found", "retryable": False},
        )
    return snapshot


@router.get("/scoped-jobs/{job_id}/items")
async def scoped_job_items_endpoint(
    job_id: str,
    user: dict = Depends(verify_supabase_jwt),
):
    """Return only persisted item state for an owned exhaustive job."""
    _require_uuid(job_id, "job_id")
    from ..services.scoped_job_store import load_job_snapshot  # noqa: WPS433
    snapshot = await run_in_threadpool(
        lambda: load_job_snapshot(user_id=user["id"], job_id=job_id)
    )
    if not snapshot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={
            "code": "scoped_job_not_found", "retryable": False,
        })
    return {"jobId": job_id, "manifestId": snapshot.get("manifestId"), "items": snapshot["items"]}


@router.get("/scoped-jobs/{job_id}/events")
async def scoped_job_events_endpoint(
    job_id: str,
    after: str | None = None,
    user: dict = Depends(verify_supabase_jwt),
):
    """Replay stable scoped events after the caller's last observed event."""
    _require_uuid(job_id, "job_id")
    from ..services.scoped_job_store import load_job_snapshot  # noqa: WPS433
    snapshot = await run_in_threadpool(
        lambda: load_job_snapshot(user_id=user["id"], job_id=job_id)
    )
    if not snapshot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={
            "code": "scoped_job_not_found", "retryable": False,
        })
    events = list(snapshot["events"])
    if after:
        matching = next((index for index, event in enumerate(events)
                         if str(event.get("event_id")) == after), None)
        if matching is not None:
            events = events[matching + 1:]
    return {"jobId": job_id, "events": events}


async def _requeue_scoped_job(job_id: str, user_id: str, statuses: set[str] | None = None):
    _require_uuid(job_id, "job_id")
    from ..services.scoped_job_store import enqueue_scoped_job  # noqa: WPS433
    job = await run_in_threadpool(lambda: enqueue_scoped_job(
        user_id=user_id, job_id=job_id, retry_statuses=statuses,
    ))
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={
            "code": "scoped_job_not_found", "retryable": False,
        })
    return {"jobId": job_id, "status": str(job.get("status") or "queued")}


@router.post("/scoped-jobs/{job_id}/resume")
async def scoped_job_resume_endpoint(job_id: str, user: dict = Depends(verify_supabase_jwt)):
    return await _requeue_scoped_job(job_id, user["id"])


@router.post("/requests/{request_id}/resume")
async def tutor_request_resume_endpoint(
    request_id: str,
    user: dict = Depends(verify_supabase_jwt),
):
    """Idempotently resume the same durable request and assistant message."""
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", request_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid request id")
    from ..services.conversation_store import (  # noqa: WPS433
        get_tutor_request, update_tutor_request,
    )
    record = await run_in_threadpool(
        lambda: get_tutor_request(user_id=user["id"], request_id=request_id)
    )
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={
            "code": "request_state_not_found", "retryable": True,
        })
    if record.get("final_answer"):
        return record
    scoped_job_id = str(record.get("scoped_job_id") or "")
    if scoped_job_id:
        from ..services.scoped_extraction import classify_scoped_request  # noqa: WPS433
        from ..services.scoped_job_store import (  # noqa: WPS433
            load_job_snapshot,
            supersede_incompatible_job_binding,
        )
        snapshot = await run_in_threadpool(
            lambda: load_job_snapshot(user_id=user["id"], job_id=scoped_job_id)
        )
        current_spec = classify_scoped_request(str(snapshot.get("requestText") or "")) if snapshot else None
        if (
            snapshot and current_spec
            and snapshot.get("retrievalMode") != current_spec.retrieval_mode.value
        ):
            await run_in_threadpool(lambda: supersede_incompatible_job_binding(
                user_id=user["id"], job_id=scoped_job_id,
            ))
            await run_in_threadpool(lambda: update_tutor_request(
                user_id=user["id"], request_id=request_id,
                status="failed", stage="routing_corrected",
                error_code="request_routing_corrected", retryable=True,
            ))
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "code": "request_routing_corrected", "retryable": True,
                "message": "The obsolete document-wide job was detached. Continue the saved response.",
            })
        if snapshot and snapshot.get("finalText") and snapshot.get("processingFinished"):
            await run_in_threadpool(lambda: update_tutor_request(
                user_id=user["id"], request_id=request_id,
                status="completed", stage="completion_repaired",
                final_answer=str(snapshot["finalText"]), retryable=False,
            ))
            return await run_in_threadpool(
                lambda: get_tutor_request(user_id=user["id"], request_id=request_id)
            )
        retry_count = int(record.get("automatic_retry_count") or 0)
        if retry_count >= 2:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "code": "automatic_resume_exhausted", "retryable": True,
            })
        resume = await _requeue_scoped_job(scoped_job_id, user["id"])
        if resume.get("status") != "queued":
            # A live valid lease already owns the job; repeated resume calls
            # must not create a new attempt or mutate its authoritative stage.
            return record
        await run_in_threadpool(lambda: update_tutor_request(
            user_id=user["id"], request_id=request_id,
            status="recovering", stage="automatic_resume",
            error_code=None, retryable=True,
            automatic_retry_count=retry_count + 1,
        ))
        return await run_in_threadpool(
            lambda: get_tutor_request(user_id=user["id"], request_id=request_id)
        )
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
        "code": "automatic_resume_exhausted", "retryable": True,
        "message": "This request requires the saved Continue response action.",
    })


@router.post("/scoped-jobs/{job_id}/retry-failed")
async def scoped_job_retry_failed_endpoint(job_id: str, user: dict = Depends(verify_supabase_jwt)):
    return await _requeue_scoped_job(job_id, user["id"], {"failed"})


@router.post("/scoped-jobs/{job_id}/retry-unresolved")
async def scoped_job_retry_unresolved_endpoint(job_id: str, user: dict = Depends(verify_supabase_jwt)):
    return await _requeue_scoped_job(job_id, user["id"], {"unresolved"})


@router.post("/ask-stream")
async def ask_stream_endpoint(
    payload: AskStreamRequest,
    user: dict = Depends(verify_supabase_jwt),
    x_request_id: str | None = Header(default=None, alias="X-Request-ID"),
    x_idempotency_key: str | None = Header(default=None, alias="X-Idempotency-Key"),
):
    """Complete access preflight, then expose the deferred pipeline over SSE."""
    started = time.perf_counter()
    supplied_request_id = x_request_id.strip() if isinstance(x_request_id, str) else ""
    supplied_idempotency_key = (
        x_idempotency_key.strip() if isinstance(x_idempotency_key, str) else ""
    )
    body_request_id = (payload.requestId or "").strip()
    provided_request_ids = {
        value for value in (
            body_request_id, supplied_request_id, supplied_idempotency_key,
        ) if value
    }
    if len(provided_request_ids) > 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={
            "code": "request_id_mismatch",
            "message": "The request identity is inconsistent.",
            "retryable": False,
            "stage": "request_validation",
        })
    request_id = (
        body_request_id or supplied_request_id or supplied_idempotency_key
        if re.fullmatch(
            r"[A-Za-z0-9._:-]{8,128}",
            body_request_id or supplied_request_id or supplied_idempotency_key,
        )
        else uuid.uuid4().hex
    )
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
    # Structured grounding is authoritative when present.  Viewer context is
    # copied only to viewer fields and can never mutate retrieval scope.
    grounding_request = payload.groundingRequest
    if grounding_request:
        if grounding_request.retrievalScope.type == "documents":
            payload.documentIds = list(grounding_request.retrievalScope.documentIds)
            payload.courseFileScope = "specific_files"
        else:
            payload.documentIds = None
            payload.documentNames = None
            payload.courseFileScope = "all_course_files"
        if grounding_request.viewerContext:
            payload.activeDocumentId = grounding_request.viewerContext.documentId
            payload.viewerRevision = grounding_request.viewerContext.revision
            payload.visiblePage = grounding_request.viewerContext.visiblePage
        if grounding_request.visiblePageContext is not None:
            payload.visiblePageContext = grounding_request.visiblePageContext
    else:
        legacy_ids = list(payload.documentIds or [])
        grounding_request = GroundingRequest.model_validate({
            "retrievalScope": {
                "type": "documents" if (
                    (payload.courseFileScope or "").casefold() == "specific_files" and legacy_ids
                ) else "course",
                "documentIds": legacy_ids if (
                    (payload.courseFileScope or "").casefold() == "specific_files" and legacy_ids
                ) else [],
            },
            "viewerContext": ({
                "documentId": payload.activeDocumentId,
                "revision": payload.viewerRevision,
                "visiblePage": payload.visiblePage,
            } if payload.activeDocumentId and payload.visiblePage else None),
            "visiblePageContext": payload.visiblePageContext or payload.openFileContext,
        })
    # visiblePageContext is the canonical name; keep the old field as an
    # internal compatibility alias until all deployed clients have migrated.
    payload.openFileContext = payload.visiblePageContext or payload.openFileContext
    requested_access = (
        grounding_request.documentAccess.requested
        if grounding_request.documentAccess else None
    )
    resolved_access, resolution_reason = resolve_document_access(
        question=question,
        requested=requested_access,
        viewer_context=grounding_request.viewerContext,
    )
    processing_pipeline = select_processing_pipeline(question, resolved_access)
    routing_started = time.perf_counter()
    # The most recent USER turn (not this current question) — used only to
    # keep a follow-up-shaped message ("what about c < 0?") from being
    # treated as a continuation when it actually names a new topic ("what
    # about rolling bearings?" right after a torsion explanation).
    previous_user_question = next(
        (turn.text for turn in reversed(payload.previousTurns or [])
         if turn.role == "user" and turn.text.strip()),
        None,
    )
    _task_profile, execution_plan = resolve_execution_plan(
        question=question,
        resolved_access=resolved_access,
        processing_pipeline=processing_pipeline,
        source_mode=payload.sourceMode,
        has_previous_answer=any(
            turn.role == "assistant" and bool(turn.text.strip())
            for turn in (payload.previousTurns or [])
        ),
        previous_question=previous_user_question,
    )
    routing_ms = (time.perf_counter() - routing_started) * 1000
    for document_id in payload.documentIds or []:
        _require_uuid(document_id, "documentId")
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")
    # Backward-compatible rollout: an older cached frontend may have already
    # persisted the durable turn through /conversations/ensure but omit the
    # same IDs from this body. Recover them from the authoritative request row
    # using the shared X-Request-ID rather than failing the user's message.
    if payload.durableConversation and request_id and not all((
        payload.clientMessageId, payload.assistantMessageId,
    )):
        from ..services.conversation_store import get_tutor_request  # noqa: WPS433
        durable_turn = await run_in_threadpool(lambda: get_tutor_request(
            user_id=user_id, request_id=request_id,
        ))
        if durable_turn and (
            not payload.conversationId
            or str(durable_turn.get("conversation_id") or "") == payload.conversationId
        ):
            payload.conversationId = str(durable_turn.get("conversation_id") or payload.conversationId or "")
            payload.clientMessageId = str(durable_turn.get("user_client_message_id") or "") or None
            payload.assistantMessageId = str(durable_turn.get("assistant_client_message_id") or "") or None
            payload.requestSnapshot = payload.requestSnapshot or dict(durable_turn.get("request_snapshot") or {})
            log.info(
                "durable_turn_identity_restored request_id=%s conversation_id=%s",
                request_id, payload.conversationId,
            )
    if payload.durableConversation and not all((
        payload.conversationId,
        payload.clientMessageId,
        payload.assistantMessageId,
        request_id,
    )):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={
            "code": "incomplete_durable_turn_identity",
            "message": "The document request is missing its durable conversation identity.",
            "retryable": False,
            "stage": "request_validation",
        })
    if payload.durableConversation:
        from ..services.conversation_store import update_tutor_request  # noqa: WPS433
        try:
            await run_in_threadpool(lambda: update_tutor_request(
                user_id=user_id,
                request_id=request_id,
                status="running",
                stage="request_preflight",
            ))
        except Exception as exc:  # noqa: BLE001
            log.exception(
                "ask_stream_preflight_state_failed request_id=%s exception=%s",
                request_id,
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "request_state_initialization_failed",
                    "message": "The document request state could not be initialized.",
                    "retryable": True,
                    "stage": "request_preflight",
                    "requestId": request_id,
                },
                headers={"X-Request-ID": request_id},
            ) from exc
        log.info(
            "ask_stream_preflight_started request_id=%s document_id=%s visible_page=%s",
            request_id,
            payload.activeDocumentId,
            payload.visiblePage,
        )
    if payload.openFileContext and len(payload.openFileContext) > _MAX_STREAM_OPEN_FILE_CTX_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileContext is too long")
    if payload.selectedText and len(payload.selectedText) > 12000:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="selectedText is too long")
    if payload.visiblePage is not None and payload.visiblePage < 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="visiblePage must be positive")
    validated_images = _validate_open_file_images(payload.openFileImages)
    log.info(
        "ask_stream_preflight_checkpoint request_id=%s checkpoint=visual_payload_validated images=%s",
        request_id,
        len(validated_images),
    )
    visual_meta = payload.visualContextMeta
    validated_image_pages = [
        int(image["page"]) for image in validated_images if image.get("page") is not None
    ]
    if payload.activePdfVisible and not payload.activeDocumentId:
        async def incomplete_active_pdf_stream():
            yield _error_sse(
                code="active_pdf_state_incomplete",
                message=(
                    "The PDF is visible, but its document identity is incomplete. "
                    "Reopen the PDF and retry."
                ),
                retryable=True,
                request_id=request_id,
            )
        return StreamingResponse(
            incomplete_active_pdf_stream(), media_type="text/event-stream"
        )
    snapshot_mismatch = bool(
        visual_meta
        and visual_meta.snapshotId
        and (
            visual_meta.activeDocumentId != payload.activeDocumentId
            or visual_meta.renderedPage != payload.visiblePage
            or visual_meta.renderedImageCount != len(validated_images)
            or visual_meta.capturedImagePages != validated_image_pages
            or any(page != payload.visiblePage for page in validated_image_pages)
        )
    )
    if snapshot_mismatch:
        async def mismatched_snapshot_stream():
            yield _error_sse(
                code="visible_page_snapshot_mismatch",
                message=(
                    "The visible PDF evidence did not match the requested page. "
                    "Please retry."
                ),
                retryable=True,
                request_id=request_id,
            )
        return StreamingResponse(
            mismatched_snapshot_stream(), media_type="text/event-stream"
        )
    if execution_plan.executionLane in {
        ExecutionLane.FAST_GENERAL, ExecutionLane.FAST_CONTEXTUAL,
    }:
        from ..services.general_answer import stream_general_answer  # noqa: WPS433

        def fast_general_stream():
            first_token_ms: float | None = None
            answer_parts: list[str] = []
            yield _sse_bytes(json.dumps({
                "meta": True, "requestId": request_id, "streamProtocolVersion": 2,
                "executionPlan": execution_plan.to_api(),
                "executionLane": execution_plan.executionLane.value,
                "groundingMode": execution_plan.groundingMode.value,
                "processingPipeline": execution_plan.processingPipeline,
                "resolvedDocumentAccess": resolved_access.value,
                "resolutionReason": resolution_reason.value,
            }, ensure_ascii=False))
            final_event: dict[str, Any] = {}
            previous_turns = [
                {"role": turn.role, "text": turn.text}
                for turn in (payload.previousTurns or [])[-2:]
            ] if execution_plan.executionLane is ExecutionLane.FAST_CONTEXTUAL else []
            try:
                fast_events = (
                    iter(({"t": chitchat_answer(question)}, {"done": True, "model": "deterministic"}))
                    if is_non_academic_chitchat(question)
                    else stream_general_answer(question, previous_turns=previous_turns)
                )
                for event in fast_events:
                    if isinstance(event.get("t"), str):
                        if first_token_ms is None:
                            first_token_ms = (time.perf_counter() - started) * 1000
                        answer_parts.append(event["t"])
                        yield _sse_bytes(json.dumps({"t": event["t"], "requestId": request_id}, ensure_ascii=False))
                    elif event.get("done"):
                        final_event = event
                answer = "".join(answer_parts)
                total_ms = (time.perf_counter() - started) * 1000
                if payload.durableConversation:
                    from ..services.conversation_store import update_tutor_request  # noqa: WPS433
                    update_tutor_request(user_id=user_id, request_id=request_id,
                                         status="completed", stage="completed",
                                         final_answer=answer, retryable=False)
                record_usage(feature="ask_stream_fast_general", model=final_event.get("model"),
                             prompt_tokens=final_event.get("promptTokens"),
                             completion_tokens=final_event.get("completionTokens"), user_id=user_id)
                log.info(
                    "ai_execution_latency request_id=%s execution_lane=%s grounding_mode=%s "
                    "auth_ms=%.0f routing_ms=%.2f ttft_ms=%.0f total_ms=%.0f retrieval_ms=0 rerank_ms=0",
                    request_id, execution_plan.executionLane.value,
                    execution_plan.groundingMode.value, access_ms, routing_ms,
                    first_token_ms or total_ms, total_ms,
                )
                yield _sse_bytes(json.dumps({
                    "done": True, "requestId": request_id, "answerMode": "general",
                    "executionPlan": execution_plan.to_api(),
                    "executionLane": execution_plan.executionLane.value,
                    "groundingMode": execution_plan.groundingMode.value,
                    "ttftMs": round(first_token_ms or total_ms), "totalMs": round(total_ms),
                    "routingMs": round(routing_ms, 2), "authMs": round(access_ms, 2),
                    "sources": [], "cacheHit": False,
                }, ensure_ascii=False))
            except Exception:
                log.exception("fast_general_failed request_id=%s", request_id)
                if payload.durableConversation:
                    from ..services.conversation_store import update_tutor_request  # noqa: WPS433
                    update_tutor_request(user_id=user_id, request_id=request_id,
                                         status="failed", stage="fast_generation",
                                         partial_answer="".join(answer_parts) or None,
                                         error_code="fast_generation_failed", retryable=True)
                yield _error_sse(code="fast_generation_failed",
                                 message="The fast response could not be completed.",
                                 retryable=True, request_id=request_id,
                                 stage="fast_generation", recoverable=True,
                                 partial_answer_available=bool(answer_parts))
        return StreamingResponse(fast_general_stream(), media_type="text/event-stream",
                                 headers={"X-Request-ID": request_id, "X-Accel-Buffering": "no"})
    task_traits = classify_task_traits(
        question,
        visible_text=payload.openFileContext or "",
        has_visible_image=bool(validated_images),
        active_document_id=payload.activeDocumentId,
    )
    text_quality = assess_text_quality(payload.openFileContext or "")
    requirement = evidence_requirement(
        traits=task_traits,
        current_page_text=payload.openFileContext or "",
        text_quality=text_quality,
        image_count=len(validated_images),
    )
    has_capture_candidate = bool(validated_images or payload.selectedRegion)
    if (
        requirement == "image_required"
        and not has_capture_candidate
    ) or (
        requirement == "image_preferred"
        and not has_capture_candidate
        and text_quality < 0.80
    ):
        async def missing_visual_stream():
            yield _error_sse(
                code="visible_page_capture_failed",
                message=(
                    "The current PDF page could not be captured. "
                    "Minallo did not continue with unrelated sources."
                ),
                retryable=True,
                request_id=request_id,
            )
        return StreamingResponse(missing_visual_stream(), media_type="text/event-stream")

    resolved_ids = list(payload.documentIds) if payload.documentIds else []
    document_name_resolution = None
    if not resolved_ids and payload.documentNames:
        document_name_resolution = await run_in_threadpool(
            lambda: _resolve_document_names(user_id, payload.courseId, payload.documentNames)
        )
        resolved_ids = list(document_name_resolution["resolved_ids"])
        ambiguous = document_name_resolution["ambiguous_candidates"]
        if ambiguous and not resolved_ids:
            # Two or more documents share a requested filename and none of the
            # OTHER requested names resolved unambiguously either — proceeding
            # would silently drop the file from retrieval, indistinguishable
            # from "no such file". Ask which one instead of guessing.
            requested_name = str(ambiguous[0].get("requestedName") or ambiguous[0].get("name") or "that file")
            candidate_count = len({c.get("id") for c in ambiguous if c.get("requestedName") == ambiguous[0].get("requestedName")})

            async def ambiguous_document_name_stream():
                yield _sse_bytes(json.dumps({
                    "meta": True,
                    "requestId": request_id,
                    "streamProtocolVersion": 2,
                    "ambiguousDocumentName": {
                        "requestedName": requested_name,
                        "candidateCount": candidate_count,
                    },
                }, ensure_ascii=False))
                yield _error_sse(
                    code="ambiguous_document_name",
                    message=(
                        f'There are {candidate_count} files named "{requested_name}" in this course. '
                        "Open the one you mean from the Study Panel instead of naming it in the "
                        "message, so Minallo knows exactly which one to use."
                    ),
                    retryable=False,
                    request_id=request_id,
                    stage="source_readiness",
                    recoverable=True,
                )

            return StreamingResponse(
                ambiguous_document_name_stream(), media_type="text/event-stream",
            )
    if (
        resolved_access is ResolvedDocumentAccess.FULL_DOCUMENT
        and grounding_request.retrievalScope.type == "course"
    ):
        candidates = await run_in_threadpool(
            lambda: _load_authorized_course_candidates(user_id, payload.courseId)
        )
        safe_candidates = [{
            "id": row["id"],
            "label": row.get("file_name") or "Document",
        } for row in candidates]

        async def full_document_scope_required_stream():
            yield _sse_bytes(json.dumps({
                "meta": True,
                "requestId": request_id,
                "streamProtocolVersion": 2,
                "resolvedDocumentAccess": resolved_access.value,
                "resolutionReason": resolution_reason.value,
                "processingPipeline": processing_pipeline,
                "executionPlan": execution_plan.to_api(),
                "executionLane": execution_plan.executionLane.value,
                "fullDocumentScope": {
                    "candidates": safe_candidates,
                    "maxDocuments": get_settings().full_document_max_documents,
                    "maxExpectedPages": get_settings().full_document_max_total_expected_pages,
                },
            }, ensure_ascii=False))
            yield _error_sse(
                code="FULL_DOCUMENT_SCOPE_REQUIRED",
                message="Select the documents to process completely before starting this request.",
                retryable=False,
                request_id=request_id,
                stage="grounding_resolution",
                recoverable=True,
            )

        return StreamingResponse(
            full_document_scope_required_stream(), media_type="text/event-stream"
        )
    preflight_documents = await run_in_threadpool(
        lambda: _load_authorized_documents(user_id, payload.courseId, resolved_ids)
    )
    if payload.activeDocumentId:
        preflight_documents.update(await run_in_threadpool(
            lambda: _load_authorized_documents(user_id, payload.courseId, [payload.activeDocumentId])
        ))
    # Authorization is complete at this point.  Only now may revision/page
    # manifests be enumerated.  This ordering is a security invariant.
    document_revisions = {
        document_id: str(row.get("active_index_revision") or row.get("document_hash") or "")
        for document_id, row in preflight_documents.items()
    }
    if payload.viewerRevision and payload.activeDocumentId:
        available_revision = document_revisions.get(payload.activeDocumentId, "")
        if available_revision and payload.viewerRevision != available_revision:
            async def grounding_revision_unavailable_stream():
                yield _error_sse(
                    code="GROUNDING_REVISION_UNAVAILABLE",
                    message="The document changed after this request started. Restart using the latest version.",
                    retryable=False,
                    request_id=request_id,
                    stage="grounding_resolution",
                    recoverable=True,
                    metadata={
                        "documentId": payload.activeDocumentId,
                        "expectedRevision": payload.viewerRevision,
                        "availableRevision": available_revision,
                    },
                )
            return StreamingResponse(
                grounding_revision_unavailable_stream(), media_type="text/event-stream"
            )
    canonical_manifests: dict[str, list[Any]] = {}
    if resolved_access is ResolvedDocumentAccess.FULL_DOCUMENT:
        settings = get_settings()
        if len(resolved_ids) > settings.full_document_max_documents:
            expected_pages = 0
        else:
            try:
                for document_id in resolved_ids:
                    canonical_manifests[document_id] = await run_in_threadpool(
                        lambda row=preflight_documents[document_id]: _load_canonical_manifest(row)
                    )
            except Exception:
                # ValueError/KeyError = a genuinely bad/missing manifest; any
                # other exception here is a transient failure of the
                # document_page_manifests read itself (e.g. a Supabase
                # blip) — this whole block runs before ask_stream_endpoint's
                # early_stream try/except exists, so an uncaught exception
                # here previously crashed with a raw 500 instead of the
                # DOCUMENT_INDEXING typed error this empty-manifests fallback
                # already produces a few lines below.
                canonical_manifests = {}
            expected_pages = sum(
                1 for manifest in canonical_manifests.values()
                for page in manifest if page.required_for_processing
            )
        if (
            not canonical_manifests
            or len(resolved_ids) > settings.full_document_max_documents
            or expected_pages > settings.full_document_max_total_expected_pages
        ):
            code = (
                "DOCUMENT_INDEXING" if not canonical_manifests
                else "FULL_DOCUMENT_LIMIT_EXCEEDED"
            )
            async def full_document_preflight_failure_stream():
                if code == "DOCUMENT_INDEXING":
                    from ..services.execution_commentary import (  # noqa: WPS433
                        CommentaryEmitter, CommentaryKind,
                    )
                    yield _commentary_sse(CommentaryEmitter(request_id).emit(
                        kind=CommentaryKind.RECOVERY, stage="document_indexing",
                        facts={"document_count": len(resolved_ids)},
                        replace_key="source_readiness",
                    ))
                yield _error_sse(
                    code=code,
                    message=(
                        "This document index is still being verified."
                        if code == "DOCUMENT_INDEXING" else
                        "The selected documents exceed the safe exhaustive-processing limit."
                    ),
                    retryable=code == "DOCUMENT_INDEXING",
                    request_id=request_id,
                    stage="VERIFYING_INDEX" if code == "DOCUMENT_INDEXING" else "grounding_resolution",
                    recoverable=True,
                    metadata={
                        "documentCount": len(resolved_ids),
                        "expectedPages": expected_pages,
                        "maxDocuments": settings.full_document_max_documents,
                        "maxExpectedPages": settings.full_document_max_total_expected_pages,
                    },
                )
            return StreamingResponse(
                full_document_preflight_failure_stream(), media_type="text/event-stream"
            )
    grounding_resolution = GroundingResolution(
        documentIds=resolved_ids,
        documentRevisions={key: document_revisions.get(key, "") for key in resolved_ids},
        documentAccess=resolved_access,
        resolutionReason=resolution_reason,
        processingPipeline=processing_pipeline,
    )
    payload.requestSnapshot = {
        **(payload.requestSnapshot or {}),
        "groundingRequest": grounding_request.model_dump(mode="json"),
        "groundingResolution": grounding_resolution.model_dump(mode="json"),
    }
    if (
        resolved_access is ResolvedDocumentAccess.FULL_DOCUMENT
        and processing_pipeline != "extraction"
    ):
        async def exhaustive_document_stream():
            from ..services.execution_commentary import (  # noqa: WPS433
                CommentaryEmitter, CommentaryKind,
            )
            commentary = CommentaryEmitter(request_id)
            async def emit(event: dict[str, Any]):
                if payload.durableConversation:
                    from ..services.conversation_store import append_tutor_commentary  # noqa: WPS433
                    try:
                        await run_in_threadpool(lambda: append_tutor_commentary(
                            user_id=user_id, request_id=request_id, event=event,
                        ))
                    except Exception as exc:
                        log.warning("commentary_persist_failed request_id=%s exception=%s",
                                    request_id, type(exc).__name__)
                return _commentary_sse(event)
            expected_pages = sum(
                1 for manifest in canonical_manifests.values()
                for page in manifest if page.required_for_processing
            )
            yield _sse_bytes(json.dumps({
                "meta": True,
                "requestId": request_id,
                "streamProtocolVersion": 2,
                "resolvedDocumentAccess": resolved_access.value,
                "resolutionReason": resolution_reason.value,
                "processingPipeline": processing_pipeline,
                "groundingRequest": grounding_request.model_dump(mode="json"),
                "groundingResolution": grounding_resolution.model_dump(mode="json"),
            }, ensure_ascii=False))
            yield await emit(commentary.emit(
                kind=CommentaryKind.ORIENTATION, stage="full_document_selected",
                facts={"access_mode": "full_document"}, replace_key="access_resolution",
            ))
            yield await emit(commentary.emit(
                kind=CommentaryKind.DOCUMENT_PROCESSING, stage="manifest_verified",
                facts={"expected_pages": expected_pages, "document_count": len(resolved_ids)},
                progress={"current": 0, "total": expected_pages, "unit": "pages"},
                replace_key="full_document_processing",
            ))
            pipeline_stage = {
                "summarization": "summarization_started",
                "comparison": "comparison_started",
                "generation": "generation_started",
            }.get(processing_pipeline)
            if pipeline_stage:
                yield await emit(commentary.emit(
                    kind=CommentaryKind.ANALYSIS, stage=pipeline_stage,
                    facts={"pipeline": processing_pipeline}, replace_key="task_processing",
                ))
            yield _status_sse("checking_completeness")
            from ..services.full_document_processing import process_full_documents  # noqa: WPS433
            # process_full_documents makes one OpenAI call per page batch per
            # document — by far the most API-call-heavy path in this router —
            # and, unlike the rest of ask-stream, this whole generator is
            # returned directly as a StreamingResponse with no surrounding
            # try/except at all. Before this guard, a bare OpenAI rate-limit/
            # timeout/API error here silently killed the SSE connection with
            # NO error frame whatsoever (worse than falling through to
            # internal_error) since meta/commentary frames had already been
            # sent. Distinct code from FULL_DOCUMENT_COVERAGE_INCOMPLETE,
            # which is reserved for "coverage was computed but incomplete".
            try:
                result = await run_in_threadpool(lambda: process_full_documents(
                    user_id=user_id,
                    course_id=payload.courseId,
                    question=question,
                    pipeline=processing_pipeline,
                    documents={key: preflight_documents[key] for key in resolved_ids},
                    manifests=canonical_manifests,
                ))
            except Exception:
                log.exception("full_document_processing_failed request_id=%s", request_id)
                yield _error_sse(
                    code="FULL_DOCUMENT_PROCESSING_FAILED",
                    message="Minallo could not finish processing the full document.",
                    retryable=True,
                    request_id=request_id,
                    stage="document_processing",
                    recoverable=True,
                )
                return
            coverage = result["coverageResult"]
            if not coverage.get("complete"):
                processed_pages = sum(
                    int(item.get("processedPages") or 0)
                    for item in coverage.get("documents") or []
                )
                yield await emit(commentary.emit(
                    kind=CommentaryKind.VALIDATION, stage="coverage_incomplete",
                    facts={"expected_pages": expected_pages, "processed_pages": processed_pages},
                    progress={"current": processed_pages, "total": expected_pages, "unit": "pages"},
                    replace_key="full_document_processing",
                ))
                yield _error_sse(
                    code="FULL_DOCUMENT_COVERAGE_INCOMPLETE",
                    message="Minallo could not process every expected page, so it did not claim a complete answer.",
                    retryable=True,
                    request_id=request_id,
                    stage="document_coverage",
                    recoverable=True,
                    metadata={"coverageResult": coverage},
                )
                return
            yield await emit(commentary.emit(
                kind=CommentaryKind.VALIDATION, stage="coverage_complete",
                facts={"expected_pages": expected_pages, "processed_pages": expected_pages},
                progress={"current": expected_pages, "total": expected_pages, "unit": "pages"},
                replace_key="full_document_processing",
            ))
            answer = str(result.get("answer") or "")
            for start in range(0, len(answer), 28):
                yield _sse_bytes(json.dumps({"t": answer[start:start + 28]}, ensure_ascii=False))
            yield _sse_bytes(json.dumps({
                "done": True,
                "answer": answer,
                "requestId": request_id,
                "resolvedDocumentAccess": resolved_access.value,
                "resolutionReason": resolution_reason.value,
                "processingPipeline": processing_pipeline,
                "groundingResolution": grounding_resolution.model_dump(mode="json"),
                "coverageResult": coverage,
                "sources": result.get("sources") or [],
                "cacheHit": False,
            }, ensure_ascii=False))
        return StreamingResponse(exhaustive_document_stream(), media_type="text/event-stream")
    log.info(
        "ask_stream_preflight_checkpoint request_id=%s checkpoint=documents_authorized documents=%s",
        request_id,
        len(preflight_documents),
    )
    preflight_doc_names = {
        document_id: str(row.get("file_name") or "")
        for document_id, row in preflight_documents.items()
    }
    explicitly_selected = [
        preflight_documents[document_id]
        for document_id in resolved_ids
        if document_id in preflight_documents
    ]
    unready_selected = [
        row for row in explicitly_selected
        if _selected_document_readiness_issue(row)
    ]
    # Cached metadata can lie (processing_status='ready' + a stale non-zero
    # chunk_count while document_chunks is actually empty) — only worth the
    # extra live query once the cheap check above already passed.
    corrupt_selected = (
        [row for row in explicitly_selected if _selected_document_index_corrupt(row)]
        if not unready_selected else []
    )
    if unready_selected or corrupt_selected:
        blocked = unready_selected[0] if unready_selected else corrupt_selected[0]
        file_name = str(blocked.get("file_name") or "the selected document")
        document_status = (
            (_selected_document_readiness_issue(blocked) or "not_ready")
            if unready_selected else "index_corrupt"
        )

        async def selected_document_not_ready_stream():
            yield _sse_bytes(json.dumps({
                "meta": True,
                "requestId": request_id,
                "streamProtocolVersion": 2,
                "selectedDocument": {
                    "id": blocked.get("id"),
                    "fileName": file_name,
                    "status": document_status,
                },
            }, ensure_ascii=False))
            is_corrupt = document_status.casefold() == "index_corrupt"
            is_failed = document_status.casefold() == "failed"
            yield _error_sse(
                code=(
                    "DOCUMENT_INDEX_CORRUPT" if is_corrupt
                    else "DOCUMENT_INDEXING_FAILED" if is_failed
                    else "DOCUMENT_INDEXING"
                ),
                message=(
                    "This document's search index is incomplete and needs to be rebuilt."
                    if is_corrupt else
                    f'Indexing failed for "{file_name}". Minallo did not use a partial index.'
                    if is_failed else
                    f'"{file_name}" is still being prepared for document search. '
                ),
                retryable=not is_failed,
                request_id=request_id,
                stage=(
                    "VERIFYING_INDEX" if document_status == "invalid_index_metadata"
                    else "INDEXING"
                ),
                recoverable=True,
                metadata={
                    "documentId": blocked.get("id"),
                    "stage": document_status,
                },
            )

        return StreamingResponse(
            selected_document_not_ready_stream(), media_type="text/event-stream",
        )
    preflight_ms = (time.perf_counter() - started) * 1000
    log.info(
        "ask_stream_preflight_checkpoint request_id=%s checkpoint=stream_ready preflight_ms=%.0f",
        request_id,
        preflight_ms,
    )

    # Exhaustive document work is queued before the SSE generator starts. The
    # browser stream observes durable state; it does not execute the job.
    precreated_scoped_job: dict[str, Any] | None = None
    if (
        payload.durableConversation and payload.conversationId
        and payload.clientMessageId and payload.assistantMessageId
        and payload.activeDocumentId
    ):
        from ..services.scoped_extraction import (  # noqa: WPS433
            RetrievalMode, classify_scoped_request,
        )
        early_spec = classify_scoped_request(question)
        if early_spec.retrieval_mode is RetrievalMode.COVERAGE:
            from ..services.scoped_job_store import create_or_resume_job  # noqa: WPS433
            active_row = dict(preflight_documents.get(payload.activeDocumentId) or {})
            early_revision = str(
                active_row.get("active_index_revision") or active_row.get("updated_at") or ""
            )
            early_fingerprint = str(
                active_row.get("document_hash") or early_revision or payload.activeDocumentId
            )
            worker_payload = payload.model_dump(mode="json")
            worker_payload["requestId"] = request_id
            try:
                precreated_scoped_job = await run_in_threadpool(lambda: create_or_resume_job(
                    user_id=user_id, course_id=payload.courseId,
                    document_id=payload.activeDocumentId or "",
                    document_revision_id=early_revision,
                    source_fingerprint=early_fingerprint,
                    request_text=question, spec=early_spec,
                    conversation_id=payload.conversationId,
                    user_message_id=payload.clientMessageId,
                    assistant_message_id=payload.assistantMessageId,
                    request_id=request_id,
                    request_payload=worker_payload,
                ))
            except Exception as exc:  # noqa: BLE001
                log.exception(
                    "scoped_job_precreation_failed request_id=%s conversation_id=%s assistant_message_id=%s",
                    request_id, payload.conversationId, payload.assistantMessageId,
                )

                async def scoped_precreation_error_stream():
                    yield _sse_bytes(json.dumps({
                        "meta": True, "requestId": request_id,
                        "streamProtocolVersion": 2,
                    }, ensure_ascii=False))
                    yield _error_sse(
                        code="scoped_job_precreation_failed",
                        message="The exhaustive document job could not be started.",
                        retryable=True,
                        request_id=request_id,
                        stage="job_creation",
                        recoverable=True,
                    )

                return StreamingResponse(
                    scoped_precreation_error_stream(), media_type="text/event-stream",
                    headers={"X-Request-ID": request_id},
                )
            log.info(
                "scoped_job_created_before_expensive_work request_id=%s job_id=%s",
                request_id, precreated_scoped_job["id"],
            )

    async def persist_request_state(**fields: Any) -> None:
        if not payload.durableConversation:
            return
        from ..services.conversation_store import update_tutor_request  # noqa: WPS433
        for attempt in (1, 2):
            try:
                await run_in_threadpool(lambda: update_tutor_request(
                    user_id=user_id, request_id=request_id, **fields,
                ))
                return
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "tutor_request_persist_retry request_id=%s attempt=%s exception=%s",
                    request_id, attempt, type(exc).__name__,
                )
                if attempt == 1:
                    await asyncio.sleep(0.2)
        log.error("tutor_request_persist_failed request_id=%s", request_id)

    async def persist_commentary_event(event: dict[str, Any]) -> None:
        if not payload.durableConversation:
            return
        from ..services.conversation_store import append_tutor_commentary  # noqa: WPS433
        try:
            await run_in_threadpool(lambda: append_tutor_commentary(
                user_id=user_id, request_id=request_id, event=event,
            ))
        except Exception as exc:  # commentary must not break the answer path
            log.warning("commentary_persist_failed request_id=%s exception=%s",
                        request_id, type(exc).__name__)

    async def early_stream():
        from ..services.execution_commentary import (  # noqa: WPS433
            CommentaryEmitter, CommentaryKind,
        )
        commentary = CommentaryEmitter(request_id)
        terminal_event_sent = False
        persisted_answer = ""
        last_shared_generation_check = 0.0
        last_shared_generation_result = True
        last_request_heartbeat = 0.0
        useful_ttft_ms: float | None = None
        final_execution_lane = execution_plan.executionLane.value
        escalation_reason: str | None = None

        async def persist_heartbeat(stage: str) -> None:
            nonlocal last_request_heartbeat
            now = time.monotonic()
            if now - last_request_heartbeat < 8.0:
                return
            last_request_heartbeat = now
            await persist_request_state(status="running", stage=stage)

        async def generation_is_current(*, check_shared: bool = True) -> bool:
            nonlocal last_shared_generation_check, last_shared_generation_result
            from ..services.request_generation import is_current_generation  # noqa: WPS433
            if not is_current_generation(
                user_id, payload.conversationId, payload.conversationGeneration
            ):
                return False
            if (
                not check_shared
                or not payload.conversationId
                or payload.conversationGeneration is None
            ):
                return True
            # Token/status events can arrive dozens of times per second. The
            # persisted generation is shared cancellation state, not something
            # that needs a database round-trip per SSE frame.
            now = time.monotonic()
            if now - last_shared_generation_check < 2.0:
                return last_shared_generation_result
            from ..services.tutor_state_store import current_persisted_generation  # noqa: WPS433
            try:
                persisted = await run_in_threadpool(
                    lambda: current_persisted_generation(
                        user_id, payload.conversationId or ""
                    )
                )
            except Exception as first_exc:
                log.warning(
                    "shared_generation_check_retry request_id=%s exception=%s",
                    request_id, type(first_exc).__name__,
                )
                await asyncio.sleep(0.25)
                try:
                    persisted = await run_in_threadpool(
                        lambda: current_persisted_generation(
                            user_id, payload.conversationId or ""
                        )
                    )
                except Exception as exc:
                    raise TutorPipelineError(
                        code="shared_generation_check_failed",
                        stage="conversation_state",
                        message="Minallo could not verify the active response state.",
                        retryable=True,
                        recoverable=True,
                    ) from exc
            last_shared_generation_check = now
            last_shared_generation_result = (
                persisted == payload.conversationGeneration
            )
            return last_shared_generation_result

        first_sse_ms = (time.perf_counter() - started) * 1000
        yield _sse_bytes(json.dumps({
            "meta": True,
            "requestId": request_id,
            "streamProtocolVersion": 2,
            "resolvedDocumentAccess": resolved_access.value,
            "resolutionReason": resolution_reason.value,
            "processingPipeline": processing_pipeline,
            "executionPlan": execution_plan.to_api(),
            "executionLane": execution_plan.executionLane.value,
            "groundingRequest": grounding_request.model_dump(mode="json"),
            "groundingResolution": grounding_resolution.model_dump(mode="json"),
        }, ensure_ascii=False))
        yield _status_sse("reading_question")
        access_commentary = commentary.emit(
            kind=CommentaryKind.ORIENTATION,
            stage=(
                "full_document_selected" if resolved_access.value == "full_document"
                else "visible_page_selected" if resolved_access.value == "visible_page"
                else "request_received"
            ),
            facts={"visible_page": payload.visiblePage or 0,
                   "access_mode": resolved_access.value},
            replace_key="access_resolution",
        )
        await persist_commentary_event(access_commentary)
        yield _commentary_sse(access_commentary)
        if resolved_ids:
            authorized_commentary = commentary.emit(
                kind=CommentaryKind.SOURCE_RESOLUTION, stage="documents_authorized",
                facts={"document_count": len(resolved_ids)}, replace_key="source_resolution",
            )
            await persist_commentary_event(authorized_commentary)
            yield _commentary_sse(authorized_commentary)
        await persist_request_state(status="running", stage="conversation_state")
        last_status_key = "reading_question"
        last_heartbeat = time.monotonic()
        log.info(
            "ai_stream_timing request_id=%s phase=first_sse access_ms=%.0f preflight_ms=%.0f first_sse_ms=%.0f",
            request_id, access_ms, preflight_ms, first_sse_ms,
        )
        try:
            if precreated_scoped_job:
                scoped_id = str(precreated_scoped_job["id"])
                yield _sse_bytes(json.dumps({
                    "event": "scope.job.created",
                    "eventId": f"job:{scoped_id}:created",
                    "jobId": scoped_id,
                    "requestId": request_id,
                    "conversationId": payload.conversationId,
                    "userMessageId": payload.clientMessageId,
                    "assistantMessageId": payload.assistantMessageId,
                    "status": str(precreated_scoped_job.get("status") or "queued"),
                }, ensure_ascii=False))
                log.info(
                    "scope_job_created_event_emitted request_id=%s job_id=%s",
                    request_id, scoped_id,
                )
                extraction_commentary = commentary.emit(
                    kind=CommentaryKind.ANALYSIS, stage="extraction_started",
                    facts={"pipeline": "extraction"}, replace_key="task_processing",
                )
                await persist_commentary_event(extraction_commentary)
                yield _commentary_sse(extraction_commentary)
                from ..services.scoped_job_store import load_job_snapshot  # noqa: WPS433
                seen_scoped_event_ids: set[str] = set()
                while True:
                    snapshot = await run_in_threadpool(lambda: load_job_snapshot(
                        user_id=user_id, job_id=scoped_id,
                    ))
                    if not snapshot:
                        raise TutorPipelineError(
                            code="scoped_job_state_unavailable", stage="job_state",
                            message="The exhaustive job state is temporarily unavailable.",
                            retryable=True, recoverable=True,
                        )
                    for scoped_event in snapshot.get("events") or []:
                        event_id = str(scoped_event.get("event_id") or "")
                        if not event_id or event_id in seen_scoped_event_ids:
                            continue
                        yield _sse_bytes(json.dumps({
                            "event": scoped_event.get("event_type"),
                            "eventId": event_id,
                            "jobId": scoped_id,
                            "payload": scoped_event.get("payload") or {},
                        }, ensure_ascii=False))
                        seen_scoped_event_ids.add(event_id)
                    if snapshot.get("finalText") and snapshot.get("processingFinished"):
                        persisted_answer = str(snapshot["finalText"])
                        yield _sse_bytes(json.dumps({"t": persisted_answer}, ensure_ascii=False))
                        yield _sse_bytes(json.dumps({
                            "meta": True, "scopedJobId": scoped_id,
                            "manifestId": snapshot.get("manifestId"),
                            "learningJourney": snapshot.get("learningJourney"),
                            "sources": snapshot.get("sources") or [],
                            "answerMode": snapshot.get("answerMode"),
                        }, ensure_ascii=False))
                        terminal_event_sent = True
                        yield _sse_bytes(json.dumps({"done": True, "requestId": request_id}, ensure_ascii=False))
                        return
                    if snapshot.get("status") in {
                        "failed", "failed_recoverable", "failed_terminal", "cancelled", "superseded",
                    }:
                        raise TutorPipelineError(
                            code="scoped_worker_interrupted", stage=str(snapshot.get("status")),
                            message="The exhaustive job paused and can be resumed.",
                            retryable=snapshot.get("status") != "failed_terminal", recoverable=True,
                        )
                    stage = str(snapshot.get("status") or "discovering")
                    yield _status_sse(
                        "preparing_document_structure" if stage in {"queued", "structural_indexing", "discovering", "recovering"}
                        else "extracting_items"
                    )
                    await asyncio.sleep(1.5)
            status_queue: asyncio.Queue[Any] = asyncio.Queue()
            prepared_task = asyncio.create_task(
                _prepare_ask_stream_response(
                    payload, user, status_queue.put_nowait, request_id,
                    {
                        "resolved_document_ids": resolved_ids,
                        "document_name_resolution": document_name_resolution,
                        "doc_name_map": preflight_doc_names,
                        "documents": preflight_documents,
                        "execution_plan": execution_plan,
                    },
                )
            )
            preparation_started = time.monotonic()
            while not prepared_task.done():
                try:
                    status_event = await asyncio.wait_for(status_queue.get(), timeout=0.1)
                    # The preparation task claims the persisted generation.
                    # Checking shared state before that claim races against the
                    # previous turn after a reload.
                    if not await generation_is_current(check_shared=False):
                        prepared_task.cancel()
                        await asyncio.gather(prepared_task, return_exceptions=True)
                        terminal_event_sent = True
                        await persist_request_state(
                            status="failed", stage="conversation_state",
                            error_code="request_superseded", retryable=False,
                        )
                        yield _error_sse(
                            code="request_superseded",
                            message="This request was replaced by a newer question.",
                            retryable=False,
                            request_id=request_id,
                        )
                        return
                    if isinstance(status_event, dict):
                        if status_event.get("type") == "execution.escalation":
                            final_execution_lane = str(status_event.get("finalLane") or final_execution_lane)
                            escalation_reason = str(status_event.get("escalationReason") or "") or None
                        last_heartbeat = time.monotonic()
                        yield _sse_bytes(json.dumps(status_event, ensure_ascii=False))
                        continue
                    status_key = str(status_event)
                    last_status_key = status_key
                    last_heartbeat = time.monotonic()
                    commentary_stage = {
                        "collecting_sources": (CommentaryKind.RETRIEVAL, "retrieval_started", "retrieval"),
                        "searching_course_material": (CommentaryKind.RETRIEVAL, "retrieval_started", "retrieval"),
                        "extracting_items": (CommentaryKind.ANALYSIS, "extraction_started", "task_processing"),
                        "recovering_response": (CommentaryKind.RECOVERY, "recovery_started", "recovery"),
                        "verifying_answer": (CommentaryKind.VALIDATION, "answer_validation_started", "validation"),
                    }.get(status_key)
                    if commentary_stage:
                        kind, commentary_name, replace_key = commentary_stage
                        stage_commentary = commentary.emit(
                            kind=kind, stage=commentary_name, replace_key=replace_key,
                        )
                        await persist_commentary_event(stage_commentary)
                        yield _commentary_sse(stage_commentary)
                    yield _status_sse(status_key)
                except asyncio.TimeoutError:
                    if (not precreated_scoped_job and time.monotonic() - preparation_started
                            >= _FOCUSED_RESPONSE_STAGE_TIMEOUT_SECONDS):
                        prepared_task.cancel()
                        raise TutorPipelineError(
                            code="response_stage_stalled", stage="document_preparation",
                            message="The document preparation stage stopped making progress.",
                            retryable=True, recoverable=True,
                        )
                    if time.monotonic() - last_heartbeat >= 10.0:
                        # Long document scans and map batches must keep the SSE
                        # connection visibly alive.
                        yield _status_sse(last_status_key)
                        last_heartbeat = time.monotonic()
                        await persist_heartbeat(last_status_key or "preparing_response")
                    continue
            try:
                prepared = await prepared_task
            except (TimeoutError, ConnectionError, OSError) as exc:
                log.warning(
                    "tutor_pipeline_retry request_id=%s stage=conversation_state attempt=1 exception=%s",
                    request_id, type(exc).__name__,
                )
                yield _status_sse("recovering_response")
                await asyncio.sleep(0.45)
                # The request identity, document snapshot and conversation
                # generation stay unchanged, so downstream persistence remains
                # idempotent while only the failed preparation stage is retried.
                prepared = await _prepare_ask_stream_response(
                    payload, user, status_queue.put_nowait, request_id,
                    {
                        "resolved_document_ids": resolved_ids,
                        "document_name_resolution": document_name_resolution,
                        "doc_name_map": preflight_doc_names,
                        "documents": preflight_documents,
                        "execution_plan": execution_plan,
                    },
                )
            while not status_queue.empty():
                if not await generation_is_current():
                    terminal_event_sent = True
                    await persist_request_state(
                        status="failed", stage="conversation_state",
                        error_code="request_superseded", retryable=False,
                    )
                    yield _error_sse(
                        code="request_superseded",
                        message="This request was replaced by a newer question.",
                        retryable=False,
                        request_id=request_id,
                    )
                    return
                queued_event = status_queue.get_nowait()
                if isinstance(queued_event, dict):
                    yield _sse_bytes(json.dumps(queued_event, ensure_ascii=False))
                else:
                    yield _status_sse(str(queued_event))
            body_iterator = prepared.body_iterator.__aiter__()
            next_event_task: asyncio.Task | None = None
            generation_recovery_attempts = 0
            generation_stage_started = time.monotonic()
            while True:
                if next_event_task is None:
                    next_event_task = asyncio.create_task(body_iterator.__anext__())
                ready, _ = await asyncio.wait(
                    {next_event_task}, timeout=_INNER_STREAM_HEARTBEAT_SECONDS
                )
                if not ready:
                    if (not precreated_scoped_job and time.monotonic() - generation_stage_started
                            >= _FOCUSED_RESPONSE_STAGE_TIMEOUT_SECONDS):
                        next_event_task.cancel()
                        await asyncio.gather(next_event_task, return_exceptions=True)
                        raise TutorPipelineError(
                            code="response_stage_stalled", stage="model_generation",
                            message="The answer generation stage stopped making progress.",
                            retryable=True, recoverable=True,
                        )
                    # Keep the connection active during model generation,
                    # verification, repair, and persistence—not only during
                    # response preparation.
                    yield _status_sse(last_status_key)
                    last_heartbeat = time.monotonic()
                    await persist_heartbeat(last_status_key or "model_generation")
                    continue
                try:
                    event = next_event_task.result()
                except StopAsyncIteration:
                    next_event_task = None
                    break
                except (TimeoutError, ConnectionError, OSError) as exc:
                    next_event_task = None
                    if persisted_answer or generation_recovery_attempts >= 1:
                        raise TutorPipelineError(
                            code="generation_timeout", stage="model_generation",
                            message="Minallo could not finish generating the grounded response.",
                            retryable=True, recoverable=True,
                        ) from exc
                    generation_recovery_attempts += 1
                    generation_stage_started = time.monotonic()
                    await persist_request_state(
                        status="recovering", stage="model_generation",
                        automatic_retry_count=generation_recovery_attempts,
                    )
                    yield _status_sse("recovering_response")
                    await asyncio.sleep(0.45)
                    prepared = await _prepare_ask_stream_response(
                        payload, user, status_queue.put_nowait, request_id,
                        {
                            "resolved_document_ids": resolved_ids,
                            "document_name_resolution": document_name_resolution,
                            "doc_name_map": preflight_doc_names,
                            "documents": preflight_documents,
                            "execution_plan": execution_plan,
                        },
                    )
                    body_iterator = prepared.body_iterator.__aiter__()
                    continue
                next_event_task = None
                if not await generation_is_current():
                    log.info(
                        "stale_generation_stream_stopped request_id=%s generation=%s",
                        request_id, payload.conversationGeneration,
                    )
                    terminal_event_sent = True
                    await persist_request_state(
                        status="failed", stage="conversation_state",
                        error_code="request_superseded", retryable=False,
                    )
                    yield _error_sse(
                        code="request_superseded",
                        message="This request was replaced by a newer question.",
                        retryable=False,
                        request_id=request_id,
                    )
                    break
                if _is_terminal_sse(event):
                    terminal_event_sent = True
                raw_event = event.decode("utf-8", errors="ignore") if isinstance(event, bytes) else event
                match = re.search(r"data:\s*(\{.*\})", raw_event, re.DOTALL)
                decoded_event: dict[str, Any] = {}
                if match:
                    try:
                        decoded_event = json.loads(match.group(1))
                    except json.JSONDecodeError:
                        decoded_event = {}
                if isinstance(decoded_event.get("t"), str):
                    if useful_ttft_ms is None:
                        useful_ttft_ms = (time.perf_counter() - started) * 1000
                        log.info(
                            "ai_execution_ttft request_id=%s execution_lane=%s grounding_mode=%s "
                            "auth_ms=%.0f routing_ms=%.2f ttft_ms=%.0f",
                            request_id, execution_plan.executionLane.value,
                            execution_plan.groundingMode.value, access_ms, routing_ms,
                            useful_ttft_ms,
                        )
                    persisted_answer += decoded_event["t"]
                if decoded_event.get("error") is True:
                    await persist_request_state(
                        status="interrupted" if persisted_answer else "failed",
                        stage=str(decoded_event.get("stage") or "generation"),
                        partial_answer=persisted_answer or None,
                        error_code=str(decoded_event.get("code") or "stream_error"),
                        retryable=decoded_event.get("retryable") is True,
                    )
                elif decoded_event.get("done") is True:
                    log.info(
                        "ai_execution_complete request_id=%s initial_lane=%s final_lane=%s "
                        "escalated=%s escalation_reason=%s ttft_ms=%.0f total_ms=%.0f",
                        request_id, execution_plan.initialLane.value,
                        final_execution_lane,
                        final_execution_lane != execution_plan.initialLane.value,
                        escalation_reason or "none",
                        useful_ttft_ms or 0.0, (time.perf_counter() - started) * 1000,
                    )
                    await persist_request_state(
                        status="completed", stage="completed",
                        final_answer=persisted_answer, retryable=False,
                    )
                yield event
            if not terminal_event_sent:
                terminal_event_sent = True
                await persist_request_state(
                    status="interrupted" if persisted_answer else "failed",
                    stage="stream_transport", partial_answer=persisted_answer or None,
                    error_code="stream_ended_without_terminal_event", retryable=True,
                )
                yield _error_sse(
                    code="stream_ended_without_terminal_event",
                    message="The AI connection ended before the answer completed.",
                    retryable=True,
                    request_id=request_id,
                )
        except TutorPipelineError as exc:
            terminal_event_sent = True
            await persist_request_state(
                status="interrupted" if persisted_answer else "failed",
                stage=exc.stage, partial_answer=persisted_answer or None,
                error_code=exc.code, retryable=exc.retryable,
            )
            log.warning(
                "tutor_pipeline_failed request_id=%s stage=%s error_code=%s retryable=%s",
                request_id, exc.stage, exc.code, exc.retryable,
            )
            yield _error_sse(
                code=exc.code, message=str(exc), retryable=exc.retryable,
                request_id=request_id, stage=exc.stage, recoverable=exc.recoverable,
            )
        except HTTPException as exc:
            terminal_event_sent = True
            typed_detail = exc.detail if isinstance(exc.detail, dict) else {}
            await persist_request_state(
                status="interrupted" if persisted_answer else "failed",
                stage=str(typed_detail.get("stage") or "request_validation"),
                partial_answer=persisted_answer or None,
                error_code=str(typed_detail.get("code") or "request_rejected"),
                retryable=bool(typed_detail.get("retryable", False)),
            )
            yield _error_sse(
                code=str(typed_detail.get("code") or "request_rejected"),
                message=str(typed_detail.get("message") or exc.detail),
                retryable=bool(typed_detail.get("retryable", False)),
                request_id=request_id,
                stage=str(typed_detail.get("stage") or "request_validation"),
            )
        except asyncio.CancelledError:
            await persist_request_state(
                status="interrupted" if persisted_answer else "failed",
                stage="stream_transport", partial_answer=persisted_answer or None,
                error_code="client_stream_disconnected", retryable=True,
            )
            log.info("stream_cancelled request_id=%s", request_id)
            raise
        except Exception as exc:
            log.exception("ask_stream deferred pipeline failed request_id=%s", request_id)
            if not terminal_event_sent:
                terminal_event_sent = True
                await persist_request_state(
                    status="interrupted" if persisted_answer else "failed",
                    stage="unknown", partial_answer=persisted_answer or None,
                    error_code="internal_error", retryable=True,
                )
                yield _error_sse(
                    code="internal_error",
                    message="Minallo could not complete this grounded answer.",
                    retryable=True,
                    request_id=request_id,
                    stage="unknown",
                    recoverable=True,
                )
        finally:
            log.info(
                "stream_closed request_id=%s terminal_event_sent=%s",
                request_id,
                terminal_event_sent,
            )
            log.info(
                "ai_stream_timing request_id=%s phase=total total_ms=%.0f",
                request_id, (time.perf_counter() - started) * 1000,
            )

    return StreamingResponse(
        early_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Request-ID": request_id,
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _prepare_ask_stream_response(
    payload: AskStreamRequest, user: dict, status_sink=None, request_id: str | None = None,
    preflight: dict[str, Any] | None = None,
):
    request_id = request_id or uuid.uuid4().hex
    from ..services.pipeline_observability import PipelineObserver  # noqa: WPS433
    observer = PipelineObserver(request_id)
    observer.event("request_received")
    user_id = user["id"]
    automatic_context_section = not bool((payload.conversationId or "").strip())
    if automatic_context_section:
        payload.conversationId = _automatic_context_conversation_id(payload)
        payload.conversationGeneration = 0
        observer.event(
            "conversation_context_auto_persisted",
            contextSectionHash=hashlib.sha256(
                payload.conversationId.encode()
            ).hexdigest()[:12],
            activeDocumentId=payload.activeDocumentId,
            documentCount=len(payload.documentIds or payload.documentNames or []),
        )
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

    conversation_id = (payload.conversationId or "").strip()
    generation = payload.conversationGeneration
    tutor_state = None
    if payload.durableConversation:
        from ..services.conversation_store import validate_durable_conversation  # noqa: WPS433
        try:
            conversation_valid = await run_in_threadpool(
                lambda: validate_durable_conversation(
                    user_id=user_id, conversation_id=conversation_id,
                )
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "conversation_validation_failed",
                    "retryable": True,
                },
            ) from exc
        if not conversation_valid:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "conversation_not_found", "retryable": False},
            )
    if conversation_id and generation is not None:
        from ..services.tutor_state_store import (  # noqa: WPS433
            claim_generation,
            load_tutor_state,
        )
        accepted = await run_in_threadpool(
            lambda: claim_generation(user_id, conversation_id, payload.courseId, generation)
        )
        if not accepted:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "STALE_GENERATION", "retryable": False},
            )
        tutor_state = await run_in_threadpool(
            lambda: load_tutor_state(user_id, conversation_id)
        )
        tutor_state.generation = generation
        tutor_state.course_id = payload.courseId
    elif conversation_id:
        # Legacy/internal callers may omit a generation. Persistent state is
        # still authoritative for document-extraction continuations.
        from ..services.tutor_state_store import (  # noqa: WPS433
            ensure_tutor_state,
            load_tutor_state,
        )
        try:
            tutor_state = await run_in_threadpool(
                lambda: (
                    ensure_tutor_state(user_id, conversation_id, payload.courseId)
                    if payload.durableConversation
                    else load_tutor_state(user_id, conversation_id)
                )
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "tutor_state_creation_failed",
                    "message": "Minallo could not save the document-scan progress.",
                    "retryable": True,
                },
            ) from exc
        tutor_state.course_id = payload.courseId

    tutor_mode = normalise_tutor_mode(payload.tutorMode or DEFAULT_TUTOR_MODE)
    if payload.openFileContext and len(payload.openFileContext) > _MAX_STREAM_OPEN_FILE_CTX_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileContext is too long")
    open_file_images = _validate_open_file_images(payload.openFileImages)
    observer.event(
        "payload_validated",
        activeDocumentId=payload.activeDocumentId,
        visiblePage=payload.visiblePage,
    )
    observer.event(
        "visual_evidence_validated",
        imageCount=len(open_file_images),
        imageRegions=[image["region"] for image in open_file_images],
    )
    log.info(
        "visual_evidence_path request_id=%s expected=%s active_document=%s "
        "visible_page=%s frontend_rendered=%s validated_images=%d "
        "image_formats=%s image_regions=%s selected_region=%s open_text_chars=%d",
        request_id,
        payload.visualEvidenceExpected,
        bool(payload.activeDocumentId),
        payload.visiblePage,
        (
            payload.visualContextMeta.renderedImageCount
            if payload.visualContextMeta else None
        ),
        len(open_file_images),
        [image["mediaType"] for image in open_file_images],
        [image["region"] for image in open_file_images],
        bool(payload.selectedRegion),
        len((payload.openFileContext or "").strip()),
    )
    previous_turns_payload: list[dict[str, str]] = [
        {"role": t.role, "text": t.text} for t in (payload.previousTurns or [])
    ]
    execution_plan = (preflight or {}).get("execution_plan")
    if automatic_context_section and tutor_state:
        # The standalone chatbot has one chronological visible transcript.
        # For server-created document/course sections, use only that section's
        # persisted history so pronouns cannot bind to another open file.
        previous_turns_payload = [
            {"role": str(turn.get("role") or ""), "text": str(turn.get("text") or "")}
            for turn in tutor_state.recent_section_turns[-16:]
            if turn.get("role") in {"user", "assistant"} and turn.get("text")
        ]

    # "Selected file(s)" scope: the chatbot sends file NAMES (it has no document
    # ids), so resolve them to ids here. Fall back to ids the client did send.
    resolved_document_ids = list((preflight or {}).get("resolved_document_ids") or [])
    document_name_resolution = (preflight or {}).get("document_name_resolution")
    if not preflight and not resolved_document_ids and payload.documentNames:
        document_name_resolution = await run_in_threadpool(
            lambda: _resolve_document_names(user_id, payload.courseId, payload.documentNames)
        )
        resolved_document_ids = list(document_name_resolution["resolved_ids"])
    requested_documents_unresolved = bool(
        (payload.courseFileScope or "").strip().lower() == "specific_files"
        and document_name_resolution
        and document_name_resolution.get("unresolved_names")
    )
    requested_documents_ambiguous = bool(
        (payload.courseFileScope or "").strip().lower() == "specific_files"
        and document_name_resolution
        and document_name_resolution.get("ambiguous_candidates")
    )
    if not payload.activeDocumentId and len(resolved_document_ids) == 1 and not (
        requested_documents_unresolved or requested_documents_ambiguous
    ):
        # A single selected file is an unambiguous active document even when
        # the standalone chatbot did not originate from the legacy PDF viewer.
        payload.activeDocumentId = resolved_document_ids[0]
    # Explicit file selections are all-or-nothing: partial resolution must not
    # retrieve from the surviving subset or broaden to the whole course.
    effective_scope = payload.courseFileScope
    if (
        (payload.courseFileScope or "").strip().lower() == "specific_files"
        and payload.documentNames
        and not resolved_document_ids
        and not requested_documents_ambiguous
    ):
        requested_documents_unresolved = True

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
        explicit_response_language=(
            payload.responseLanguage
            or (tutor_state.response_language if tutor_state else None)
        ),
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
    numbered_section = find_numbered_section_reference(
        question, previous_turns_payload,
    )
    requested_subpart_range = bool(re.search(
        r"\b\d+(?:\.\d+)+\s*(?:to|bis|-|â€“|â€”|and|und)\s*"
        r"\d+(?:\.\d+)+\b",
        question, re.IGNORECASE,
    ))
    requests_section_coverage = bool(numbered_section and re.search(
        r"\b(?:answer|solve|explain|in detail|detailed|all|every|"
        r"beantworte|lÃ¶se|erklÃ¤re|ausfÃ¼hrlich|alle)\b",
        question, re.IGNORECASE,
    ))
    if numbered_section and (requested_subpart_range or requests_section_coverage):
        coverage_instruction = (
            "Answer and explain every explicitly requested numbered subpart; "
            "do not omit either requested range."
            if requested_subpart_range else
            f"Answer and explain every numbered subpart in section {numbered_section.number}; "
            "do not replace the answers with an overview."
        )
        resolved_question = f"{resolved_question}\n\n{coverage_instruction}"
    from ..services.explicit_questions import detect_explicit_questions  # noqa: WPS433
    explicit_questions = detect_explicit_questions(question)
    log.info(
        "explicit_question_detection request_id=%s question_count=%d self_contained=%s "
        "visual_reference=%s exact_scope=%s inventory_hash=%s",
        request_id, explicit_questions.question_count, explicit_questions.self_contained,
        explicit_questions.contains_visual_reference, explicit_questions.exact_scope,
        explicit_questions.inventory_hash[:16] or None,
    )
    # A complete current-message request outranks passive viewer state. A PDF
    # may still contribute retrieval evidence, but an old selection cannot turn
    # ten written questions into a marked-region follow-up.
    selected_region = None if explicit_questions.self_contained else payload.selectedRegion
    selection_stale = _selection_is_stale(
        selected_region,
        visible_page=payload.visiblePage,
        viewer_revision=payload.viewerRevision,
    )
    verified_region = None
    region_error_code: str | None = "stale_selection" if selection_stale else None
    if selected_region and not selection_stale:
        if (
            not payload.activeDocumentId
            or selected_region.coordinateSpace != "normalized_pdf_page"
            or selected_region.page != payload.visiblePage
        ):
            region_error_code = "invalid_selection"
        else:
            from ..services.pdf_region_evidence import (  # noqa: WPS433
                RegionEvidenceError,
                verify_pdf_region,
            )

            document_row = dict(
                ((preflight or {}).get("documents") or {}).get(
                    payload.activeDocumentId
                )
                or {}
            )
            try:
                verified_region = await run_in_threadpool(
                    lambda: verify_pdf_region(
                        document=document_row,
                        page=selected_region.page,
                        bbox=(
                            selected_region.x,
                            selected_region.y,
                            selected_region.x + selected_region.width,
                            selected_region.y + selected_region.height,
                        ),
                        claimed_revision=(
                            selected_region.documentRevision
                            or payload.viewerRevision
                        ),
                        client_text=payload.selectedText,
                        page_rotation=selected_region.pageRotation or 0,
                    )
                )
            except RegionEvidenceError as exc:
                log.warning(
                    "pdf_region_rejected request_id=%s code=%s document=%s page=%s",
                    request_id,
                    exc.code,
                    bool(payload.activeDocumentId),
                    selected_region.page,
                )
                region_error_code = exc.code
    selected_region_id = verified_region.id if verified_region else None
    selected_text = verified_region.prompt_text() if verified_region else None
    reference = resolve_question_reference(
        question=resolved_question,
        course_id=payload.courseId,
        active_document_id=payload.activeDocumentId,
        active_document_name=(
            doc_name_map.get(payload.activeDocumentId or "") or payload.activeFileName
        ),
        visible_page=payload.visiblePage,
        selected_text=selected_text,
        selected_region_id=selected_region_id,
        visible_text=payload.openFileContext,
        has_visible_image=bool(open_file_images),
    )
    evidence_decision = decide_evidence(
        reference,
        question=resolved_question,
        has_history=bool(previous_turns_payload),
    )
    has_current_page_evidence = bool(
        (payload.openFileContext or "").strip() or open_file_images
    )
    if region_error_code and not (
        region_error_code == "stale_selection" and has_current_page_evidence
    ):
        evidence_decision.can_answer = False
        evidence_decision.action = "clarify"
        evidence_decision.recovery_code = region_error_code
        evidence_decision.missing_information = ["verified current PDF selection"]
    elif region_error_code == "stale_selection":
        log.info(
            "stale_selection_discarded request_id=%s current_page_evidence=true",
            request_id,
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
    if payload.visualUpload and open_file_images and not payload.activeDocumentId:
        source_decision = replace(
            source_decision,
            source_scope=SourceScope.VISUAL_UPLOAD,
            source_label="Using: Pasted screenshot",
            used_document_ids=[],
        )
    if requested_documents_unresolved:
        requested_names = list(
            (document_name_resolution or {}).get("unresolved_names")
            or [name for name in (payload.documentNames or []) if name]
        )
        display_names = ", ".join(f'\"{name}\"' for name in requested_names)
        return _stream_static_answer(
            text=(
                f"I could not reliably find {display_names or 'the requested document'}. "
                "Please choose the intended document, or explicitly choose "
                "Search the whole course instead."
            ),
            decision=source_decision,
            answer_mode="clarification",
            status_key="identifying_question",
            extra_meta={
                "taskType": "source_resolution",
                "errorCode": "requested_documents_not_resolved",
                "requestedNames": requested_names,
                "retryable": False,
                "terminalEvent": "done",
            },
        )
    if requested_documents_ambiguous:
        candidates = list(
            (document_name_resolution or {}).get("ambiguous_candidates") or []
        )
        return _stream_static_answer(
            text=(
                "More than one document matches the requested filename. "
                "Please choose the intended document."
            ),
            decision=source_decision,
            answer_mode="clarification",
            status_key="identifying_question",
            extra_meta={
                "taskType": "source_resolution",
                "errorCode": "requested_documents_ambiguous",
                "documentCandidates": candidates,
                "retryable": False,
                "terminalEvent": "done",
            },
        )

    if tutor_state:
        active_revision = (
            verified_region.document_revision if verified_region else None
        ) or payload.viewerRevision or (
            selected_region.documentRevision if selected_region else None
        ) or ""
        if payload.activeDocumentId and active_revision:
            tutor_state.change_document(payload.activeDocumentId, active_revision)
        tutor_state.active_page = payload.visiblePage
        tutor_state.active_region_id = selected_region_id
        tutor_state.region_revision = (
            verified_region.document_revision if verified_region else None
        )
        tutor_state.active_question = (
            reference.resolved_question_number or dialogue.active_question
            or tutor_state.active_question
        )
        tutor_state.response_language = language_context.requested_response_language
        tutor_state.response_mode = tutor_mode
        tutor_state.explanation_level = dialogue.requested_depth
        tutor_state.dialogue_act = dialogue.dialogue_act.value
        tutor_state.academic_task = classify_academic_intent(resolved_question).value
        tutor_state.risk_class = (
            "high" if _requires_verified_buffering(
                question=resolved_question,
                dialogue_act=dialogue.dialogue_act.value,
                has_visual_evidence=bool(selected_text or open_file_images),
                has_active_numerical_state=bool(tutor_state.reusable_results()),
            ) else "low"
        )
        tutor_state.pending_clarification = (
            evidence_decision.recovery_code if not evidence_decision.can_answer else None
        )
        tutor_state.prompt_version = "answer-stream-v2026-07-23"
        tutor_state.retrieval_version = "hybrid-v1"
        tutor_state.verifier_version = "deterministic-v1"
        label = tutor_state.active_question or ""
        subpart = re.search(r"([a-z])$", label, re.IGNORECASE)
        tutor_state.active_subquestion = subpart.group(1).lower() if subpart else None
        variant = re.search(
            r"\b(?:variant|variante)\s+([A-Za-z0-9]+)",
            selected_text or payload.openFileContext or "",
            re.IGNORECASE,
        )
        if variant:
            tutor_state.exam_variant = variant.group(1).upper()
        if selected_region_id and verified_region:
            tutor_state.evidence_dependencies[selected_region_id] = (
                verified_region.provenance()
            )
        if dialogue.invalidate_previous_answer:
            tutor_state.invalidate(
                rejected_result_ids={
                    item.id for item in tutor_state.results.values()
                    if item.status == "verified"
                },
                status="rejected",
                turn_id=request_id,
                reason=dialogue.dialogue_act.value,
            )
            # invalidate() increments its logical version; the client generation
            # remains the shared authority for this request.
            tutor_state.generation = generation
        from ..services.tutor_state_store import save_tutor_state  # noqa: WPS433
        await run_in_threadpool(
            lambda: save_tutor_state(user_id, payload.courseId, tutor_state)
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
    from ..services.reliability import identify_grounded_task  # noqa: WPS433
    preliminary_traits = classify_task_traits(
        resolved_question,
        visible_text=payload.openFileContext or "",
        has_visible_image=bool(open_file_images),
        active_document_id=payload.activeDocumentId,
    )
    page_bound_request = is_page_bound_request(
        resolved_question,
        has_selected_region=verified_region is not None,
        active_document_id=payload.activeDocumentId,
    )
    grounded_identity = identify_grounded_task(
        question=resolved_question,
        current_page_text=payload.openFileContext or "",
        document_id=payload.activeDocumentId,
        filename=payload.activeFileName,
        page=payload.visiblePage,
        traits=preliminary_traits,
        selected_region_text=selected_text or "",
    )
    visual_regrounding_attempted = False
    visual_identity = None
    visual_identity_model = None
    initial_identity_gate_required = bool(
        payload.activeDocumentId
        and page_bound_request
        and (
            grounded_identity.exercise_reference
            or preliminary_traits.requires_visual_evidence
        )
    )
    if (
        initial_identity_gate_required
        and open_file_images
        and not identity_is_sufficient(
            grounded_identity,
            traits=preliminary_traits,
            page_bound_request=page_bound_request,
        )
    ):
        from ..services.visual_repair import (  # noqa: WPS433
            build_visual_identity_prompt,
            generate_visual_task_identity,
            visual_identity_model_for_task,
        )
        visual_regrounding_attempted = True
        visual_identity_model = visual_identity_model_for_task(
            preliminary_traits,
            image_count=len(open_file_images),
            has_mapping_labels=bool(grounded_identity.visible_mapping_labels),
        )
        try:
            visual_identity = await run_in_threadpool(
                lambda: generate_visual_task_identity(
                    prompt=build_visual_identity_prompt(
                        user_question=resolved_question,
                        requested_exercise=grounded_identity.exercise_reference,
                        visible_page=payload.visiblePage,
                        active_filename=payload.activeFileName,
                        selected_region_present=verified_region is not None,
                    ),
                    images=open_file_images,
                    model=visual_identity_model or get_settings().openai_generate_model,
                )
            )
        except Exception:
            visual_identity = None
            log.exception(
                "task_identity_visual_reground_failed request_id=%s",
                request_id,
            )
        text_task_references = set(re.findall(
            r"\b(?:Aufgabe|Exercise|Question|Problem)\s+(\d+(?:\.\d+)*)",
            payload.openFileContext or "",
            re.IGNORECASE,
        ))
        visual_task_references = set(
            getattr(visual_identity, "detected_task_references", []) or []
        ) if visual_identity else set()
        combined_task_references = {
            re.sub(r"[^0-9.]", "", value).strip(".")
            for value in text_task_references | visual_task_references if value
        }
        detected_task_count = max(
            len(combined_task_references),
            int(getattr(visual_identity, "detected_task_count", 0) or 0)
            if visual_identity else 0,
        )
        grounded_identity = merge_grounded_task_identity(
            user_identity=grounded_identity,
            text_identity=grounded_identity,
            visual_identity=visual_identity,
            has_selected_region=verified_region is not None,
            detected_task_count=detected_task_count or None,
        )
    observer.event(
        "task_classified",
        visualKind=preliminary_traits.visual_kind.value,
        numericalValidation=preliminary_traits.requires_numerical_validation,
        preDisplayVerification=preliminary_traits.requires_pre_display_verification,
        textFallbackAllowed=preliminary_traits.allows_text_fallback,
    )
    observer.event(
        "task_identity_resolved",
        exerciseReference=grounded_identity.exercise_reference,
        taskType=grounded_identity.task_kind,
        visiblePage=grounded_identity.visible_page or payload.visiblePage,
        resolvedTaskPage=grounded_identity.resolved_task_page,
        identityResolutionMethod=grounded_identity.identity_resolution_method.value,
        identityEvidencePages=grounded_identity.identity_evidence_pages,
        visualIdentityBinding=(
            grounded_identity.visual_identity_binding.value
            if grounded_identity.visual_identity_binding else None
        ),
        exerciseVisibleOnPage=grounded_identity.exercise_visible_on_page,
        sourceConfidence=grounded_identity.source_confidence,
    )
    image_hashes = [
        hashlib.sha256(str(image.get("data") or "").encode()).hexdigest()
        for image in open_file_images
    ]
    base_ws_fingerprint = ws_fingerprint

    # ── Cache check (same logic as /ask) ─────────────────────────────────────
    # When the request carries openFileContext (the user is reading a PDF
    # and asking "this question / this section"), the answer is bound to
    # whatever page is visible — not just the document set. Bypass cache to
    # avoid returning a previous answer composed against a different page.
    version_hash = ""
    cached = None
    has_open_ctx = (
        bool(payload.openFileContext and payload.openFileContext.strip())
        or bool(open_file_images)
        or verified_region is not None
    )
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
        and (
            not (
                payload.activeDocumentId
                and (
                    grounded_identity.exercise_reference
                    or preliminary_traits.requires_visual_evidence
                )
            )
            or identity_is_sufficient(
                grounded_identity,
                traits=preliminary_traits,
                page_bound_request=page_bound_request,
            )
        )
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
    fallback_retrieval_document_ids = effective_document_ids(
        document_ids=resolved_document_ids,
        active_document_id=payload.activeDocumentId,
        course_file_scope=course_file_scope,
    )
    final_grounding_state = derive_grounding_state(
        active_document_id=payload.activeDocumentId,
        visible_page=payload.visiblePage,
        identity=grounded_identity,
        traits=preliminary_traits,
        fallback_document_ids=fallback_retrieval_document_ids,
        question=resolved_question,
        has_valid_selected_region=bool(verified_region),
        document_revision=payload.viewerRevision,
        visible_page_text=payload.openFileContext or "",
        image_hashes=image_hashes,
    )
    retrieval_scope = final_grounding_state.retrieval_scope
    retrieval_document_ids = final_grounding_state.retrieval_document_ids
    cache_obligations = final_grounding_state.answer_obligations
    reliability_cache_fingerprint = final_grounding_state.reliability_fingerprint
    cache_grounding_payload = final_grounding_state.cache_grounding_payload
    structured_grounding_fingerprint = grounding_cache_payload(
        user_id=user_id,
        course_id=payload.courseId,
        request=grounding_request,
        resolution=grounding_resolution,
        question=resolved_question,
        conversation_grounding_state=json.dumps(previous_turns_payload, sort_keys=True),
        execution_lane=execution_plan.executionLane.value,
    )
    ws_fingerprint = hashlib.sha256(
        f"{base_ws_fingerprint}:{reliability_cache_fingerprint}:"
        f"{cache_grounding_payload}:{structured_grounding_fingerprint}".encode()
    ).hexdigest()
    observer.event(
        "retrieval_scope_resolved",
        activeDocumentId=payload.activeDocumentId,
        documentCount=len(retrieval_document_ids or []),
        preferredPages=retrieval_scope.preferred_pages,
        exerciseReference=retrieval_scope.exercise_reference,
        allowCourseFallback=retrieval_scope.allow_course_fallback,
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
            verified_region.evidence_sha256 if verified_region else None
        ),
        "response_language": language_context.requested_response_language,
        "viewer_revision": payload.viewerRevision,
        "grounding_mode": source_decision.grounding_policy.value,
        "conversation_generation": payload.conversationGeneration,
        "model_version": (
            f"{get_settings().openai_generate_model}|"
            f"{get_settings().openai_generate_model_strong}"
        ),
    }
    from ..services.question_routing import build_question_routing_plan  # noqa: WPS433
    cache_routing_plan = build_question_routing_plan(question)
    cache_key_kwargs["routing_fingerprint"] = json.dumps({
        **cache_routing_plan.trace(),
        "explicitQuestionInventoryHash": explicit_questions.inventory_hash or None,
        "explicitQuestionCount": explicit_questions.question_count,
        "exactScope": explicit_questions.exact_scope,
        "visualReference": explicit_questions.contains_visual_reference,
    }, sort_keys=True, ensure_ascii=False)
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
        if cached and explicit_questions.question_count:
            cached_answer = str(cached.get("answer") or "")
            forbidden_visual_fallback = (
                "I cannot reliably identify the marked question" in cached_answer
                or "Please open that page or select the question area" in cached_answer
                or "Ich kann die markierte Aufgabe" in cached_answer
            )
            if forbidden_visual_fallback or not cached_answer.strip():
                log.info(
                    "invalid_explicit_question_cache_rejected request_id=%s question_count=%d",
                    request_id, explicit_questions.question_count,
                )
                cached = None
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
            "pedagogicalAnalysis": cached.get("pedagogicalAnalysis"),
            "learningRecommendations": cached.get("learningRecommendations") or [],
            "visualAids": cached.get("visualAids") or [],
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
            "pedagogicalAnalysis": cached.get("pedagogicalAnalysis"),
            "learningRecommendations": cached.get("learningRecommendations") or [],
            "visualAids": cached.get("visualAids") or [],
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

    # Exhaustive extraction is a full-document map/reduce task, not semantic
    # top-k QA. Run it against every stored page of the active document and
    # keep citation display limits independent from extraction coverage.
    from ..services.document_extraction import (  # noqa: WPS433
        DocumentExtractionContext,
        classify_document_extraction,
        extraction_context_from_api,
        extraction_context_to_api,
        extraction_pages_for_direction,
        extract_document_qa,
        build_learning_journey,
        format_document_extraction,
        infer_extraction_rescan_direction,
        save_extraction_context,
    )
    from ..services.document_extraction_cache import (  # noqa: WPS433
        ExtractionCacheQuality,
        load_verified_extraction_cache,
        promote_verified_extraction_cache,
    )
    from ..services.scoped_extraction import (  # noqa: WPS433
        DiscoveryStatus,
        DetectedHeading,
        RequestScopeManifest,
        RetrievalMode,
        ScopeItem,
        ScopeItemStatus,
        classify_scoped_request,
        finalise_scoped_job,
        resolve_scoped_request,
        stable_scope_key,
    )
    from ..services.scoped_job_store import (  # noqa: WPS433
        EXTRACTOR_SCHEMA_VERSION,
        create_or_resume_job,
        emit_job_event,
        load_active_manifest,
        load_question_unit_ranges,
        mark_job_discovery,
        persist_item_state,
        persist_job_state,
        persist_manifest_candidate,
        persist_structural_checkpoint,
        persist_scoped_result,
    )
    document_extraction, extraction_correction, extraction_target = (
        classify_document_extraction(question, previous_turns_payload)
    )
    scoped_request = resolve_scoped_request(question, previous_turns_payload)
    if scoped_request.target_type == "focused_numbered_target":
        # A bounded section/exercise may ask for "all questions" inside that
        # section. The legacy conversation-aware extraction classifier used
        # that phrase to override the explicit target and launch a complete
        # document map. Exact target identity is the stronger routing signal.
        document_extraction = False
        extraction_correction = False
    # Compatibility-period reconciliation. classify_document_extraction() runs
    # in this separate function, independently of resolve_document_access()
    # in ask_stream_endpoint — they now share the same exhaustive-quantifier
    # and extraction-target vocabulary, but classify_document_extraction()
    # also has logic resolve_document_access() doesn't (explicit_question_
    # list, continuation-context re-derivation), so they can still disagree.
    # The structured contract must be the source of truth once that happens,
    # not a bystander: nothing downstream (telemetry, a resumed request, the
    # frontend's own requestSnapshot) may see exhaustive extraction actually
    # run while GroundingResolution.documentAccess still claims relevance or
    # visible_page.
    if document_extraction:
        grounding_resolution_snapshot = dict(
            (payload.requestSnapshot or {}).get("groundingResolution") or {}
        )
        if grounding_resolution_snapshot.get("documentAccess") != "full_document":
            grounding_resolution_snapshot.update({
                "documentAccess": "full_document",
                "resolutionReason": "legacy_extraction_classifier",
                "processingPipeline": "extraction",
            })
            payload.requestSnapshot = {
                **(payload.requestSnapshot or {}),
                "groundingResolution": grounding_resolution_snapshot,
            }
    if document_extraction:
        if not payload.conversationId or tutor_state is None:
            return _stream_static_answer(
                text=(
                    "Minallo could not save this conversation, which is required "
                    "to scan the complete document. Your question is still preserved."
                ),
                decision=source_decision,
                answer_mode="clarification",
                status_key="checking_completeness",
                extra_meta={
                    "errorCode": "conversation_creation_failed",
                    "retryable": True,
                },
            )
        if not payload.activeDocumentId:
            return _stream_static_answer(
                text=(
                    "Open the exam PDF you want me to scan, then ask again. "
                    "An exhaustive extraction must be bound to one active document."
                ),
                decision=source_decision,
                answer_mode="clarification",
                status_key="section_not_found",
                extra_meta={
                    "taskType": "document_wide_extraction",
                    "errorCode": "section_not_found",
                },
            )
        if status_sink:
            status_sink("scanning_document")
            status_sink("extracting_items")
        visible_page_image = next((
            image for image in open_file_images
            if image.get("page") == payload.visiblePage
            and image.get("region") == "full_page"
        ), None)
        visible_page_image_bytes = (
            base64.b64decode(str(visible_page_image.get("data") or ""), validate=True)
            if visible_page_image else None
        )
        observer.event(
            "document_bound_request",
            activePdfFound=bool(payload.activeDocumentId and payload.visiblePage),
            activeDocumentIdPresent=bool(payload.activeDocumentId),
            visiblePage=payload.visiblePage,
            pageTextStatus=(
                "ready" if (payload.openFileContext or "").strip() else "missing"
            ),
            pageTextChars=len((payload.openFileContext or "").strip()),
            imageCount=len(open_file_images),
            capturedPages=[
                image.get("page") for image in open_file_images if image.get("page")
            ],
            requestWorkflow="document_extraction",
        )
        log.info(
            "document_bound_request request_id=%s activePdfFound=%s "
            "activeDocumentIdPresent=%s visiblePage=%s pageTextStatus=%s "
            "pageTextChars=%d imageCount=%d capturedPages=%s "
            "requestWorkflow=document_extraction",
            request_id,
            bool(payload.activeDocumentId and payload.visiblePage),
            bool(payload.activeDocumentId),
            payload.visiblePage,
            "ready" if (payload.openFileContext or "").strip() else "missing",
            len((payload.openFileContext or "").strip()),
            len(open_file_images),
            [image.get("page") for image in open_file_images if image.get("page")],
        )
        active_document = dict(
            ((preflight or {}).get("documents") or {}).get(
                payload.activeDocumentId or "",
                {},
            )
        )
        document_revision = str(
            active_document.get("active_index_revision")
            or active_document.get("updated_at")
            or ""
        ) or None
        source_fingerprint = str(
            active_document.get("document_hash")
            or document_revision
            or payload.activeDocumentId
        )
        if scoped_request.retrieval_mode is not RetrievalMode.COVERAGE:
            # The legacy classifier may recognise a correction using prior
            # turns; preserve that meaning as a coverage continuation.
            scoped_request = replace(
                scoped_request,
                retrieval_mode=RetrievalMode.COVERAGE,
            )
        scoped_job = await run_in_threadpool(lambda: create_or_resume_job(
            user_id=user_id,
            course_id=payload.courseId,
            document_id=payload.activeDocumentId or "",
            document_revision_id=document_revision or "",
            source_fingerprint=source_fingerprint,
            request_text=question,
            spec=scoped_request,
            conversation_id=payload.conversationId,
            user_message_id=payload.clientMessageId,
            assistant_message_id=payload.assistantMessageId,
            request_id=request_id,
        ))
        scoped_job_id = str(scoped_job["id"])
        if status_sink:
            status_sink({
                "event": "scope.job.created",
                "eventId": f"job:{scoped_job_id}:created",
                "jobId": scoped_job_id,
                "requestId": request_id,
                "assistantMessageId": payload.assistantMessageId,
                "status": str(scoped_job.get("status") or "discovering"),
            })
        active_manifest = await run_in_threadpool(lambda: load_active_manifest(
            user_id=user_id,
            document_id=payload.activeDocumentId or "",
            document_revision_id=document_revision or "",
            canonical_target=scoped_request.canonical_target,
            source_fingerprint=source_fingerprint,
        ))
        # A durable job/message binding now exists before any expensive work.
        # A verified same-revision manifest is sufficient for a warm request;
        # never force structural reconstruction merely because the auxiliary
        # logical-unit index is marked stale.
        if (
            active_manifest is None
            and active_document.get("structural_index_status") != "structured_ready"
        ):
            if status_sink:
                status_sink("preparing_document_structure")
            from ..services.indexing import index_document  # noqa: WPS433
            observer.event(
                "structural_reindex_required",
                activeDocumentId=payload.activeDocumentId,
                scopedJobId=scoped_job_id,
            )
            await run_in_threadpool(
                lambda: index_document(payload.activeDocumentId or "", force=True)
            )
            active_document = await run_in_threadpool(lambda: _load_authorized_documents(
                user_id, payload.courseId, [payload.activeDocumentId or ""]
            ).get(payload.activeDocumentId or "", {}))
        manifest_holder: dict[str, RequestScopeManifest | None] = {
            "manifest": active_manifest,
        }
        structural_question_ranges = await run_in_threadpool(lambda: load_question_unit_ranges(
            user_id=user_id,
            document_id=payload.activeDocumentId or "",
            document_revision_id=document_revision or "",
        ))
        await run_in_threadpool(lambda: mark_job_discovery(
            scoped_job_id,
            DiscoveryStatus.COMPLETE if active_manifest else DiscoveryStatus.RUNNING,
        ))
        if active_manifest:
            emit_job_event(
                job_id=scoped_job_id,
                event_key=f"manifest.reused.{active_manifest.id}",
                event_type="warm_manifest_reused",
                payload={"manifest_id": active_manifest.id},
            )
            log.info(
                "warm_manifest_reused request_id=%s job_id=%s manifest_id=%s",
                request_id, scoped_job_id, active_manifest.id,
            )
        observer.event(
            "coverage_mode_selected",
            jobId=scoped_job_id,
            canonicalTarget=scoped_request.canonical_target,
            coverageIntent=scoped_request.coverage_intent.value,
        )
        log.info(
            "coverage_mode_selected request_id=%s job_id=%s document=%s "
            "revision=%s canonical_target=%s coverage_intent=%s",
            request_id, scoped_job_id, payload.activeDocumentId, document_revision,
            scoped_request.canonical_target, scoped_request.coverage_intent.value,
        )
        conversation_extraction_context = (
            extraction_context_from_api(tutor_state.document_extraction_context)
            if tutor_state and tutor_state.document_extraction_context
            else None
        )
        durable_cache = await run_in_threadpool(lambda: load_verified_extraction_cache(
            user_id=user_id,
            document_id=payload.activeDocumentId or "",
            document_revision=document_revision or "",
            source_fingerprint=source_fingerprint,
            target=extraction_target or "questions",
        ))
        durable_extraction_context = None
        if durable_cache:
            quality = dict(durable_cache.get("quality") or {})
            scope = dict(durable_cache.get("scope") or {})
            durable_extraction_context = extraction_context_from_api({
                "conversation_id": payload.conversationId or "",
                "document_id": payload.activeDocumentId or "",
                "document_revision": document_revision,
                "source_fingerprint": source_fingerprint,
                "target_section": extraction_target or "questions",
                "requested_scope": "complete_document",
                "scanned_pages": list(scope.get("question_pages") or []),
                "extracted_questions": list(durable_cache.get("questions") or []),
                "solution_evidence": list(durable_cache.get("answer_evidence") or []),
                "paired_items": list(durable_cache.get("paired_items") or []),
                "unresolved_item_ids": [
                    str(item.get("item_id") or "")
                    for item in (durable_cache.get("paired_items") or [])
                    if not item.get("answer_text")
                ],
                "complete": bool(quality.get("scope_complete")),
                "scope_extraction_complete": bool(quality.get("scope_complete")),
                "answer_verification_complete": all(
                    bool(item.get("answer_text"))
                    for item in (durable_cache.get("paired_items") or [])
                ),
                "cumulative_scanned_pages": list(scope.get("question_pages") or []),
                "scope_fingerprint": durable_cache.get("scope_fingerprint"),
                "resolved_family": scope.get("resolved_family"),
                "created_at": durable_cache.get("created_at"),
                "updated_at": durable_cache.get("updated_at"),
            })
        extraction_context = durable_extraction_context or conversation_extraction_context
        if extraction_context and (
            extraction_context.document_id != (payload.activeDocumentId or "")
            or extraction_context.source_fingerprint != source_fingerprint
            or extraction_context.document_revision != document_revision
            or extraction_context.target_section.casefold()
            != (extraction_target or "questions").casefold()
        ):
            extraction_context = None
        pages_to_scan = None
        previous_items = None
        direction = "full"
        if extraction_context:
            total_pages = int(active_document.get("page_count") or 0)
            if extraction_correction:
                direction = infer_extraction_rescan_direction(question)
                pages_to_scan = extraction_pages_for_direction(
                    direction,
                    context=extraction_context,
                    section_start_page=1,
                    section_end_page=total_pages,
                )
            elif not extraction_context.complete:
                # Resume an interrupted exhaustive request from the first page
                # not durably checkpointed by a completed map batch.
                already_scanned = set(extraction_context.scanned_pages)
                pages_to_scan = [
                    page for page in range(1, total_pages + 1)
                    if page not in already_scanned
                ]
                direction = "resume"
            elif (
                durable_extraction_context
                and active_manifest
                and extraction_context.scope_extraction_complete
            ):
                pages_to_scan = []
                direction = "cached_verified"
        event_loop = asyncio.get_running_loop()

        def extraction_checkpoint(progress: dict[str, Any]) -> None:
            batch_pages = list(progress.get("batch_pages") or [])
            if status_sink:
                event_loop.call_soon_threadsafe(status_sink, "extracting_items")
            partial_questions = list(progress.get("extracted_questions") or [])
            partial_solutions = list(progress.get("solution_evidence") or [])
            partial_pairs = list(progress.get("paired_items") or [])
            partial_scanned = sorted(set(progress.get("scanned_pages") or []))
            partial_item_pages = [
                item.question_page for item in partial_pairs
                if item.question_page is not None
            ]
            partial_context = DocumentExtractionContext(
                conversation_id=payload.conversationId or "",
                document_id=payload.activeDocumentId or "",
                document_revision=document_revision,
                source_fingerprint=source_fingerprint,
                target_section=extraction_target or "questions",
                requested_scope="complete_document",
                scanned_pages=partial_scanned,
                extracted_questions=partial_questions,
                solution_evidence=partial_solutions,
                paired_items=partial_pairs,
                unresolved_item_ids=[
                    item.item_id for item in partial_pairs if not item.answer_text
                ],
                unresolved_pages=list(progress.get("unreadable_pages") or []),
                answer_recovery_records=(
                    extraction_context.answer_recovery_records
                    if extraction_context else {}
                ),
                earliest_source_page=min(partial_scanned) if partial_scanned else None,
                latest_source_page=max(partial_scanned) if partial_scanned else None,
                earliest_scanned_page=min(partial_scanned) if partial_scanned else None,
                latest_scanned_page=max(partial_scanned) if partial_scanned else None,
                earliest_item_page=min(partial_item_pages) if partial_item_pages else None,
                latest_item_page=max(partial_item_pages) if partial_item_pages else None,
                complete=False,
                scope_fingerprint=(extraction_context.scope_fingerprint if extraction_context else None),
                resolved_family=(
                    extraction_context.resolved_family if extraction_context else None
                ),
            )
            save_extraction_context(partial_context)
            persist_structural_checkpoint(
                job_id=scoped_job_id,
                document_revision_id=document_revision or source_fingerprint,
                pages_total=int(active_document.get("page_count") or 0),
                pages_inspected=partial_scanned,
                unresolved_pages=list(progress.get("unreadable_pages") or []),
                text_pages_inspected=partial_scanned,
                ocr_pages_inspected=list(progress.get("ocr_pages_inspected") or []),
                visual_pages_inspected=list(progress.get("visual_pages_inspected") or []),
                remaining_visual_pages=list(progress.get("remaining_visual_pages") or []),
                current_stage=str(progress.get("current_stage") or "scope_discovery"),
            )
            if tutor_state:
                tutor_state.document_extraction_context = extraction_context_to_api(
                    partial_context
                )
                try:
                    from ..services.tutor_state_store import save_tutor_state  # noqa: WPS433
                    save_tutor_state(user_id, payload.courseId, tutor_state)
                except Exception:
                    log.exception(
                        "document_extraction_checkpoint_failed request_id=%s batch=%s/%s pages=%s",
                        request_id,
                        progress.get("batch_index"),
                        progress.get("batch_count"),
                        batch_pages,
                    )
            log.info(
                "document_extraction_checkpoint request_id=%s batch=%s/%s pages=%s scanned=%d",
                request_id,
                progress.get("batch_index"),
                progress.get("batch_count"),
                batch_pages,
                len(partial_scanned),
            )

        def discovery_checkpoint(discovery: dict[str, Any]) -> None:
            family = discovery.get("resolved_family")
            questions = list(discovery.get("questions") or [])
            sealed = bool(discovery.get("manifest_sealed"))
            matched_sections = list(getattr(family, "matched_sections", []) or []) if family else []
            persist_structural_checkpoint(
                job_id=scoped_job_id,
                document_revision_id=document_revision or source_fingerprint,
                pages_total=int(active_document.get("page_count") or 0),
                pages_inspected=list(discovery.get("question_pages") or []),
                unresolved_pages=list(discovery.get("numbering_gaps") or []),
                detected_headings=[{
                    "number": str(getattr(section, "requested_number", "")),
                    "title": str(getattr(section, "requested_title", "") or ""),
                    "page": int(getattr(section, "start_page", 0) or 0),
                } for section in matched_sections],
                included_sections=[str(getattr(section, "requested_number", "")) for section in matched_sections],
                excluded_sections=["12", "13", "14"] if scoped_request.canonical_target == "kurzfragen" else [],
                candidate_manifest_version=1,
                current_stage="manifest_validation",
            )
            if not family or not sealed:
                emit_job_event(
                    job_id=scoped_job_id,
                    event_key="manifest.discovery.incomplete",
                    event_type="scope.partially_processed",
                    payload={
                        "numbering_gaps": list(discovery.get("numbering_gaps") or []),
                        "question_pages": list(discovery.get("question_pages") or []),
                    },
                )
                return
            section_titles = {
                str(section.requested_number): (
                    section.requested_title or family.family_name
                )
                for section in family.matched_sections
            }
            candidate_items: list[ScopeItem] = []
            for order, extracted in enumerate(questions):
                number = str(extracted.item_id)
                section_number = number.split(".", 1)[0]
                structural_range = structural_question_ranges.get(number, {})
                stable_key = stable_scope_key(
                    document_revision or source_fingerprint,
                    "exam_question",
                    number,
                    extracted.question_page,
                    order,
                )
                candidate_items.append(ScopeItem(
                    id=str(uuid.uuid5(uuid.NAMESPACE_URL, stable_key)),
                    stable_key=stable_key,
                    document_id=payload.activeDocumentId or "",
                    document_revision_id=document_revision or "",
                    item_number=number,
                    label=extracted.question_text,
                    block_type="exam_question",
                    section_number=section_number,
                    section_title=section_titles.get(section_number),
                    page_start=(structural_range.get("page_start") or extracted.question_page),
                    page_end=(structural_range.get("page_end") or extracted.question_page),
                    document_order=order,
                    source_block_ids=[str(structural_range["stable_block_id"])]
                    if structural_range.get("stable_block_id") else [],
                    status=ScopeItemStatus.PENDING,
                ))
            candidate = RequestScopeManifest(
                id=str(uuid.uuid4()),
                job_id=scoped_job_id,
                document_revision_id=document_revision or "",
                discovery_status=DiscoveryStatus.COMPLETE,
                manifest_sealed=True,
                manifest_verified=False,
                included_section_numbers=list(family.section_numbers),
                excluded_section_numbers=list(family.excluded_sections),
                question_pages=list(discovery.get("question_pages") or []),
                items=candidate_items,
                source_fingerprint=source_fingerprint,
                scope_fingerprint=str(discovery.get("scope_fingerprint") or ""),
                extractor_schema_version=EXTRACTOR_SCHEMA_VERSION,
                out_of_scope_items_rejected=list(
                    discovery.get("out_of_scope_items_rejected") or []
                ),
                detected_headings=[DetectedHeading(
                    number=str(section.requested_number or ""),
                    title=section.requested_title or family.family_name,
                    page=section.start_page,
                    y_position=(
                        float(section.start_position)
                        if section.start_position is not None else None
                    ),
                    document_order=index,
                    method=section.discovery_method,
                    confidence=section.confidence,
                ) for index, section in enumerate(family.matched_sections)],
                version=(active_manifest.version + 1 if active_manifest else 1),
            )
            promotion = persist_manifest_candidate(
                user_id=user_id,
                document_id=payload.activeDocumentId or "",
                canonical_target=scoped_request.canonical_target,
                candidate=candidate,
            )
            manifest_holder["manifest"] = promotion.active_manifest

        extraction_started = time.perf_counter()
        extraction = await run_in_threadpool(
            lambda: extract_document_qa(
                user_id=user_id,
                course_id=payload.courseId,
                document_id=payload.activeDocumentId or "",
                target=extraction_target or "questions",
                pages_to_scan=pages_to_scan,
                previous_items=previous_items,
                previous_context=extraction_context,
                checkpoint=extraction_checkpoint,
                discovery_checkpoint=discovery_checkpoint,
                visible_page=payload.visiblePage,
                visible_page_text=payload.openFileContext,
                visible_page_image=visible_page_image_bytes,
                visible_page_image_media_type=(
                    str(visible_page_image.get("mediaType") or "image/png")
                    if visible_page_image else "image/png"
                ),
                active_document_id=payload.activeDocumentId,
                active_file_name=(
                    doc_name_map.get(payload.activeDocumentId or "")
                    or payload.activeFileName
                ),
            )
        )
        if (
            durable_extraction_context
            and not extraction.scope_extraction_complete
        ):
            log.warning(
                "question_inventory_regression_prevented request_id=%s document=%s "
                "previous_questions=%d candidate_questions=%d",
                request_id, payload.activeDocumentId,
                len(durable_extraction_context.extracted_questions),
                len(extraction.extracted_questions),
            )
            extraction = await run_in_threadpool(lambda: extract_document_qa(
                user_id=user_id,
                course_id=payload.courseId,
                document_id=payload.activeDocumentId or "",
                target=extraction_target or "questions",
                pages_to_scan=[],
                previous_context=durable_extraction_context,
                active_document_id=payload.activeDocumentId,
            ))
            direction = "cached_verified_regression_recovery"
        if extraction.resolved_family and extraction.scope_extraction_complete:
            question_pages = sorted({
                page
                for section in extraction.resolved_family.matched_sections
                for page in section.question_pages
            })
            cache_quality = ExtractionCacheQuality(
                scope_complete=True,
                sections_found=len(extraction.resolved_family.matched_sections),
                question_pages_processed=len(
                    set(extraction.cumulative_scanned_pages or extraction.scanned_pages)
                    .intersection(question_pages)
                ),
                question_pages_total=len(question_pages),
                questions_found=len(extraction.extracted_questions),
                out_of_scope_count=len(extraction.out_of_scope_items_rejected),
                failed_pages=sorted(set(extraction.unreadable_pages + extraction.unprocessed_pages)),
            )
            await run_in_threadpool(lambda: promote_verified_extraction_cache(
                user_id=user_id,
                document_id=payload.activeDocumentId or "",
                document_revision=document_revision or "",
                source_fingerprint=source_fingerprint,
                target=extraction_target or "questions",
                scope_fingerprint=extraction.scope_fingerprint or "",
                scope={
                    "resolved_family": asdict(extraction.resolved_family),
                    "question_pages": question_pages,
                    "included_section_numbers": extraction.resolved_family.section_numbers,
                    "excluded_section_numbers": extraction.resolved_family.excluded_sections,
                },
                questions=[asdict(item) for item in extraction.extracted_questions],
                answer_evidence=[asdict(item) for item in extraction.solution_evidence],
                paired_items=[asdict(item) for item in extraction.paired_items],
                quality=cache_quality,
            ))
        if payload.conversationId:
            scanned = sorted(set(
                (extraction_context.scanned_pages if extraction_context else [])
                + extraction.scanned_pages
            ))
            item_pages = [
                item.question_page
                for item in extraction.paired_items
                if item.question_page is not None
            ]
            persisted_extraction_context = DocumentExtractionContext(
                conversation_id=payload.conversationId,
                document_id=payload.activeDocumentId or "",
                document_revision=document_revision,
                source_fingerprint=source_fingerprint,
                target_section=extraction_target or "questions",
                requested_scope="complete_document",
                scanned_pages=scanned,
                extracted_questions=extraction.extracted_questions,
                solution_evidence=extraction.solution_evidence,
                paired_items=extraction.paired_items,
                unresolved_item_ids=extraction.unanswered_item_ids,
                unresolved_pages=extraction.unreadable_pages,
                answer_recovery_records=extraction.answer_recovery_records,
                conflicting_item_ids=extraction.conflicting_item_ids,
                earliest_source_page=min(scanned) if scanned else None,
                latest_source_page=max(scanned) if scanned else None,
                earliest_scanned_page=min(scanned) if scanned else None,
                latest_scanned_page=max(scanned) if scanned else None,
                earliest_item_page=min(item_pages) if item_pages else None,
                latest_item_page=max(item_pages) if item_pages else None,
                complete=extraction.complete,
                scope_extraction_complete=extraction.scope_extraction_complete,
                answer_verification_complete=extraction.answer_verification_complete,
                cumulative_scanned_pages=extraction.cumulative_scanned_pages,
                scope_fingerprint=extraction.scope_fingerprint,
                resolved_family=extraction.resolved_family,
            )
            save_extraction_context(persisted_extraction_context)
            if tutor_state:
                from ..services.tutor_state_store import save_tutor_state  # noqa: WPS433
                tutor_state.document_extraction_context = extraction_context_to_api(
                    persisted_extraction_context
                )
                if automatic_context_section:
                    tutor_state.recent_section_turns = (
                        tutor_state.recent_section_turns
                        + [{"role": "user", "text": question}]
                    )[-16:]
                await run_in_threadpool(
                    lambda: save_tutor_state(user_id, payload.courseId, tutor_state)
                )
        scoped_manifest = manifest_holder.get("manifest")
        scoped_job_state = None
        if scoped_manifest:
            pairs_by_id = {
                item.item_id: item for item in extraction.paired_items
            }
            retryable_answer_states = {
                "search_pending", "visual_budget_exhausted", "visual_render_failed",
                "vision_extraction_failed", "ambiguous_evidence",
            }
            for scope_item in scoped_manifest.items:
                pair = pairs_by_id.get(scope_item.item_number or "")
                recovery = extraction.answer_recovery_records.get(
                    scope_item.item_number or ""
                )
                scope_item.attempts += 1
                if pair and pair.answer_text:
                    scope_item.status = ScopeItemStatus.ANSWERED
                    scope_item.error_code = None
                    scope_item.error_message = None
                elif pair and recovery and recovery.status.value in retryable_answer_states:
                    scope_item.status = ScopeItemStatus.PENDING
                    scope_item.error_code = recovery.status.value
                    scope_item.error_message = "Answer recovery will resume from its checkpoint."
                elif pair:
                    scope_item.status = ScopeItemStatus.UNRESOLVED
                    scope_item.error_code = (
                        recovery.status.value if recovery else "official_answer_not_found"
                    )
                    scope_item.error_message = "No verified official answer was found."
                else:
                    scope_item.status = ScopeItemStatus.FAILED
                    scope_item.error_code = "missing_batch_output"
                    scope_item.error_message = "The sealed item was absent from the processing output."
                await run_in_threadpool(lambda item=scope_item, paired=pair, record=recovery: persist_item_state(
                    job_id=scoped_job_id,
                    manifest_id=scoped_manifest.id,
                    item=item,
                    result=(asdict(paired) if paired else None),
                    answer_checkpoint=(asdict(record) if record else {}),
                ))
            scoped_job_state = finalise_scoped_job(scoped_manifest)
            await run_in_threadpool(
                lambda: persist_job_state(scoped_job_id, scoped_job_state)
            )
        else:
            await run_in_threadpool(
                lambda: mark_job_discovery(scoped_job_id, DiscoveryStatus.FAILED)
            )
        if status_sink:
            status_sink("checking_completeness")
        if scoped_manifest and scoped_job_state:
            answer_text = format_document_extraction(
                extraction,
                language_context.requested_response_language,
            )
            learning_journey = build_learning_journey(
                extraction,
                scoped_job_state=scoped_job_state,
                scoped_job_id=scoped_job_id,
                manifest_id=scoped_manifest.id,
            )
        else:
            answer_text = (
                "Minallo could not verify the complete document scope yet. "
                "The document structure is being rebuilt. No partial question list was shown."
            )
            learning_journey = None
        if extraction_correction:
            if extraction.status == "no_pages_in_requested_direction":
                answer_text = (
                    "The extracted section already starts on the first relevant "
                    "page. I found no earlier pages to scan."
                    if direction == "earlier"
                    else "There are no later pages left to scan for this section."
                )
            elif extraction.new_item_count:
                answer_text = (
                    f"I found {extraction.new_item_count} "
                    f"{'earlier' if direction == 'earlier' else 'additional'} "
                    f"{extraction.target} and merged them into the list.\n\n"
                    + answer_text
                )
            elif pages_to_scan:
                answer_text = (
                    f"I rescanned pages {min(pages_to_scan)}–{max(pages_to_scan)} "
                    f"and did not find additional {extraction.target}.\n\n"
                    + answer_text
                )
        cited_pages = list(dict.fromkeys(
            [
                item.question_page
                for item in extraction.items
            ]
            + [
                item.answer_page
                for item in extraction.items
                if item.answer_page
            ]
        ))[:5]
        active_name = (
            doc_name_map.get(payload.activeDocumentId or "")
            or payload.activeFileName
            or "Active document"
        )
        extraction_sources = [
            {
                "index": index,
                "documentId": payload.activeDocumentId,
                "file_name": active_name,
                "pageStart": page,
                "pages": str(page),
                "section": extraction.target,
            }
            for index, page in enumerate(cited_pages, start=1)
        ]
        await run_in_threadpool(lambda: persist_scoped_result(
            job_id=scoped_job_id,
            final_text=answer_text,
            learning_journey=learning_journey,
            sources=extraction_sources,
            answer_mode="document_wide_extraction",
        ))
        log.info(
            "document_extraction_completed request_id=%s task_type=document_wide_extraction "
            "document=%s total_pages=%d scanned_pages=%d unreadable_pages=%s "
            "target=%s items=%d continuation_correction=%s response_language=%s "
            "rescan_direction=%s reused_context=%s language_status=valid_mixed_source "
            "coverage_complete=%s elapsed_ms=%.0f",
            request_id,
            payload.activeDocumentId,
            extraction.total_pages,
            len(extraction.scanned_pages),
            extraction.unreadable_pages,
            extraction.target,
            len(extraction.items),
            extraction_correction,
            language_context.requested_response_language,
            direction,
            bool(extraction_context),
            extraction.complete,
            (time.perf_counter() - extraction_started) * 1000,
        )
        return _stream_static_answer(
            text=answer_text,
            decision=replace(
                source_decision,
                used_document_ids=[payload.activeDocumentId],
            ),
            answer_mode="document_wide_extraction",
            sources=extraction_sources,
            model=extraction.model,
            prompt_tokens=extraction.prompt_tokens,
            completion_tokens=extraction.completion_tokens,
            status_key="checking_completeness",
            extra_meta={
                "taskType": "document_wide_extraction",
                "scopedJobId": scoped_job_id,
                "manifestId": scoped_manifest.id if scoped_manifest else None,
                "retrievalMode": scoped_request.retrieval_mode.value,
                "coverageIntent": scoped_request.coverage_intent.value,
                "canonicalTarget": scoped_request.canonical_target,
                "targetSection": extraction.target,
                "totalPages": extraction.total_pages,
                "pagesScanned": extraction.scanned_pages,
                "scannedPageCount": len(extraction.scanned_pages),
                "pageStatuses": {
                    str(page): page_status.value
                    for page, page_status in sorted(extraction.page_statuses.items())
                },
                "itemsExtracted": len(extraction.items),
                "coverageComplete": extraction.complete,
                "unreadablePages": extraction.unreadable_pages,
                "unprocessedPages": extraction.unprocessed_pages,
                "sectionResolved": extraction.section_resolved,
                "resolvedHeading": extraction.resolved_heading,
                "resolvedStartPage": extraction.resolved_start_page,
                "resolvedEndPage": extraction.resolved_end_page,
                "invalidItemIdsRejected": extraction.invalid_item_ids_rejected,
                "errorCode": (
                    "section_result_mismatch"
                    if extraction.status == "section_result_mismatch" else None
                ),
                "unresolvedItems": extraction.unanswered_item_ids,
                "answerRecoveryPages": extraction.answer_recovery_pages,
                "answerRecoveryIncomplete": extraction.answer_recovery_incomplete,
                "answerRecoveryRecords": {
                    item_id: {
                        "itemId": record.item_id,
                        "candidatePages": record.candidate_pages,
                        "inspectedPages": record.inspected_pages,
                        "remainingPages": record.remaining_pages,
                        "status": record.status.value,
                        "evidencePage": record.evidence_page,
                        "evidenceType": record.evidence_type,
                        "callsUsed": record.calls_used,
                    }
                    for item_id, record in extraction.answer_recovery_records.items()
                },
                "learningJourney": learning_journey,
                "outOfScopeItemsRejected": extraction.out_of_scope_items_rejected,
                "languageStatus": "valid_mixed_source",
                "continuationCorrection": extraction_correction,
            },
        )

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
        identity_gate_required = bool(
            payload.activeDocumentId
            and page_bound_request
            and (
                grounded_identity.exercise_reference
                or preliminary_traits.requires_visual_evidence
            )
        )
        if identity_gate_required and not identity_is_sufficient(
            grounded_identity,
            traits=preliminary_traits,
            page_bound_request=page_bound_request,
        ) and not visual_regrounding_attempted:
            regrounding_text = "\n".join(
                [
                    payload.openFileContext or "",
                    *[
                        str(getattr(chunk, "text", "") or "")
                        for chunk in visible_page_chunks
                    ],
                ]
            )
            visual_identity = None
            if open_file_images:
                from ..services.visual_repair import (  # noqa: WPS433
                    build_visual_identity_prompt,
                    generate_visual_task_identity,
                    visual_identity_model_for_task,
                )
                try:
                    visual_identity_model = visual_identity_model_for_task(
                        preliminary_traits,
                        image_count=len(open_file_images),
                        has_mapping_labels=bool(grounded_identity.visible_mapping_labels),
                    )
                    visual_identity = await run_in_threadpool(
                        lambda: generate_visual_task_identity(
                            prompt=build_visual_identity_prompt(
                                user_question=resolved_question,
                                requested_exercise=grounded_identity.exercise_reference,
                                visible_page=payload.visiblePage,
                                active_filename=payload.activeFileName,
                                selected_region_present=verified_region is not None,
                            ),
                            images=open_file_images,
                            model=visual_identity_model,
                        )
                    )
                except Exception:
                    visual_identity = None
                    log.exception(
                        "task_identity_visual_reground_failed request_id=%s",
                        request_id,
                    )
            text_identity = identify_grounded_task(
                question=resolved_question,
                current_page_text=regrounding_text,
                document_id=payload.activeDocumentId,
                filename=payload.activeFileName,
                page=payload.visiblePage,
                traits=preliminary_traits,
                selected_region_text=selected_text or "",
            )
            text_task_references = set(re.findall(
                r"\b(?:Aufgabe|Exercise|Question|Problem)\s+(\d+(?:\.\d+)*)",
                regrounding_text,
                re.IGNORECASE,
            ))
            visual_task_references = set(
                getattr(visual_identity, "detected_task_references", []) or []
            ) if visual_identity else set()
            combined_task_references = {
                re.sub(r"[^0-9.]", "", value).strip(".")
                for value in text_task_references | visual_task_references
                if value
            }
            detected_task_count = max(
                len(combined_task_references),
                int(getattr(visual_identity, "detected_task_count", 0) or 0)
                if visual_identity else 0,
            )
            grounded_identity = merge_grounded_task_identity(
                user_identity=grounded_identity,
                text_identity=text_identity,
                visual_identity=visual_identity,
                has_selected_region=verified_region is not None,
                detected_task_count=detected_task_count or None,
            )
            final_grounding_state = derive_grounding_state(
                identity=grounded_identity,
                traits=preliminary_traits,
                active_document_id=payload.activeDocumentId,
                visible_page=payload.visiblePage,
                fallback_document_ids=fallback_retrieval_document_ids,
                question=resolved_question,
                has_valid_selected_region=bool(verified_region),
                document_revision=payload.viewerRevision,
                visible_page_text=payload.openFileContext or "",
                image_hashes=image_hashes,
            )
            retrieval_scope = final_grounding_state.retrieval_scope
            retrieval_document_ids = final_grounding_state.retrieval_document_ids
            cache_obligations = final_grounding_state.answer_obligations
            reliability_cache_fingerprint = final_grounding_state.reliability_fingerprint
            cache_grounding_payload = final_grounding_state.cache_grounding_payload
            ws_fingerprint = hashlib.sha256(
                f"{base_ws_fingerprint}:{reliability_cache_fingerprint}:"
                f"{cache_grounding_payload}:{structured_grounding_fingerprint}".encode()
            ).hexdigest()
            cache_key_kwargs["selected_document_ids"] = retrieval_document_ids
            cache_key_kwargs["workspace_fingerprint"] = ws_fingerprint or None
            observer.event(
                "task_identity_regrounded",
                visualIdentityBinding=(
                    grounded_identity.visual_identity_binding.value
                    if grounded_identity.visual_identity_binding else None
                ),
                visualIdentityExercise=(
                    getattr(visual_identity, "exercise_reference", None)
                    if visual_identity else None
                ),
                requestedExercise=grounded_identity.exercise_reference,
                visiblePage=grounded_identity.visible_page,
                resolvedTaskPage=grounded_identity.resolved_task_page,
                visualIdentityModel=(visual_identity_model if open_file_images else None),
                visualIdentityConfidence=(
                    getattr(visual_identity, "confidence", None) if visual_identity else None
                ),
                sourceConfidence=grounded_identity.source_confidence,
                requestedQuantities=grounded_identity.requested_quantities,
            )
            if not identity_is_sufficient(
                grounded_identity,
                traits=preliminary_traits,
                page_bound_request=page_bound_request,
            ):
                return _stream_static_answer(
                    text=(
                        "I found the active exercise, but could not reliably identify "
                        "the requested quantity or required answer options from the "
                        "current page. The task was not sent to broad course retrieval."
                    ),
                    decision=source_decision,
                    answer_mode="clarification",
                    status_key="identifying_question",
                    extra_meta={
                        "taskType": grounded_identity.task_kind,
                        "errorCode": "task_identity_insufficient",
                        "terminalEvent": "done",
                    },
                )
        if identity_gate_required and not identity_is_sufficient(
            grounded_identity,
            traits=preliminary_traits,
            page_bound_request=page_bound_request,
        ):
            return _stream_static_answer(
                text=(
                    "I found the active exercise, but could not reliably identify "
                    "the requested quantity or required answer options from the "
                    "current page. The task was not sent to broad course retrieval."
                ),
                decision=source_decision,
                answer_mode="clarification",
                status_key="identifying_question",
                extra_meta={
                    "taskType": grounded_identity.task_kind,
                    "errorCode": "task_identity_insufficient",
                    "terminalEvent": "done",
                },
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
        observer.event(
            "primary_retrieval_started",
            documentCount=len(retrieval_document_ids or []),
        )
        try:
            fast_grounded = bool(
                execution_plan
                and execution_plan.executionLane is ExecutionLane.FAST_GROUNDED
            )
            if fast_grounded:
                exercise_hit, formula_hits, section_chunks = None, [], []
                chunks = await run_in_threadpool(lambda: retrieve_routed_chunks(
                    user_id=user_id, course_id=payload.courseId,
                    query=retrieval_query, document_ids=retrieval_document_ids,
                    preferred_document_ids=retrieval_document_ids,
                    active_document_id=payload.activeDocumentId,
                    document_name_query=question, top_k=4,
                    guarantee_documents=False, request_id=request_id,
                ))
            else:
                exercise_task = run_in_threadpool(
                lambda: retrieve_exercise_block(
                    user_id=user_id, course_id=payload.courseId, query=retrieval_query,
                    document_ids=retrieval_document_ids,
                    active_document_id=payload.activeDocumentId,
                )
            )
                chunks_task = run_in_threadpool(
                    lambda: retrieve_routed_chunks(
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
                    request_id=request_id,
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
                section_document_ids = (
                    [payload.activeDocumentId]
                    if payload.activeDocumentId else list(retrieval_document_ids or [])
                )
                section_task = run_in_threadpool(
                    lambda: retrieve_numbered_section_chunks(
                    user_id=user_id, course_id=payload.courseId,
                    document_ids=section_document_ids,
                    question=resolved_question,
                    previous_turns=previous_turns_payload,
                )
            )
                exercise_hit, chunks, formula_hits, section_chunks = await asyncio.gather(
                    exercise_task, chunks_task, formula_task, section_task,
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
        if section_chunks:
            section_ids = {chunk.chunk_id for chunk in section_chunks}
            chunks = section_chunks + [chunk for chunk in chunks if chunk.chunk_id not in section_ids]
        if visible_page_chunks:
            visible_ids = {c.chunk_id for c in visible_page_chunks}
            chunks = visible_page_chunks + [c for c in chunks if c.chunk_id not in visible_ids]
        before_dedup = len(chunks)
        chunks = _deduplicate_chunks(chunks)
        log.info(
            "ai_stream_timing request_id=%s phase=dedup input_chunks=%d output_chunks=%d",
            request_id, before_dedup, len(chunks),
        )
        observer.event(
            "primary_retrieval_completed",
            activeDocumentId=payload.activeDocumentId,
            exerciseReference=grounded_identity.exercise_reference,
            chunkCount=len(chunks),
        )

    fast_evidence_sufficient = bool(
        execution_plan
        and execution_plan.executionLane is ExecutionLane.FAST_GROUNDED
        and fast_grounded_evidence_is_sufficient(chunks=chunks, question=question)
    )
    if fast_evidence_sufficient:
        multi_item_result = SimpleNamespace(
            chunks=chunks, evidence=[], to_dict=lambda: {"items": [], "complete": True},
        )
    else:
        if execution_plan and execution_plan.executionLane is ExecutionLane.FAST_GROUNDED:
            if status_sink:
                status_sink({
                    "type": "execution.escalation",
                    "initialLane": "fast_grounded", "finalLane": "standard_rag",
                    "escalated": True,
                    "escalationReason": EscalationReason.INSUFFICIENT_GROUNDED_EVIDENCE.value,
                    "requestId": request_id,
                })
            # A failed fast probe is only a routing attempt, never the final
            # evidence set. Re-run the normal broad hybrid retrieval before
            # continuing so escalation genuinely moves upward in quality.
            standard_chunks = await run_in_threadpool(lambda: retrieve_routed_chunks(
                user_id=user_id, course_id=payload.courseId,
                query=retrieval_query, document_ids=retrieval_document_ids,
                preferred_document_ids=retrieval_document_ids,
                active_document_id=payload.activeDocumentId,
                document_name_query=question, top_k=stream_top_k,
                guarantee_documents=generative_request, request_id=request_id,
            ))
            chunks = _deduplicate_chunks([*standard_chunks, *chunks])
        multi_item_result = await run_in_threadpool(lambda: retrieve_multi_item_course_evidence(
            user_id=user_id, course_id=payload.courseId, question=question,
            document_ids=retrieval_document_ids,
            active_document_id=payload.activeDocumentId, initial_chunks=chunks,
        ))
        chunks = multi_item_result.chunks

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
    assert_authorised_course_chunks(chunks, set(retrieved_doc_ids))

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

    chunks = rank_course_chunks(chunks, doc_name_map, question)
    evidence_report = build_course_evidence_report(
        course_id=payload.courseId,
        searched_document_ids=retrieval_document_ids or retrieved_doc_ids,
        chunks=chunks,
        doc_names=doc_name_map,
        question=question,
    )
    evidence_payload = evidence_report.to_dict()
    if multi_item_result.evidence:
        evidence_payload["multiItem"] = multi_item_result.to_dict()
    source_decision = replace(source_decision, evidence_report=evidence_payload)
    fallback_research = (
        SimpleNamespace(sources=[])
        if fast_evidence_sufficient
        else await run_in_threadpool(lambda: research_unresolved_items(
            multi_item_result,
            grounding_policy=source_decision.grounding_policy.value,
        ))
    )
    if fallback_research.sources:
        source_decision = replace(source_decision, web_search_used=True)

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
        payload.openFileContext or open_file_images or exercise_hit or formula_hits
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
        if not policy_allows_general_knowledge(source_decision.grounding_policy):
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
    task_traits = preliminary_traits
    explanation_plan = build_explanation_plan(
        resolved_question,
        weak_topics=weak_topics,
        previous_turns=previous_turns_payload,
        has_selected_region=verified_region is not None,
        has_page_image=bool(open_file_images),
    )
    visual_aids = await run_in_threadpool(
        lambda: select_visual_aids(
            explanation_plan,
            context=VisualContext(
                document_id=payload.activeDocumentId,
                document_revision=payload.viewerRevision,
                page_number=payload.visiblePage,
                selected_region=(selected_region.model_dump() if selected_region else None),
                page_image_available=bool(open_file_images),
            ),
            user_id=user_id,
            course_id=payload.courseId,
            question=resolved_question,
        ),
    )
    persistent_visual_ids = [
        str(item.get("visualId")) for item in visual_aids
        if item.get("sourceType") == "course_file"
        and item.get("visualId")
        and not str(item.get("visualId")).startswith("page-")
    ]
    learning_recommendations = build_learning_recommendations(
        explanation_plan,
        course_id=payload.courseId,
        document_ids=[
            chunk.document_id for chunk in chunks
            if chunk.document_id and not chunk.document_id.startswith("__")
        ],
        source_chunk_ids=[chunk.chunk_id for chunk in chunks if chunk.chunk_id],
        visual_ids=persistent_visual_ids,
        weak_topics=weak_topics,
        previous_turns=previous_turns_payload,
        response_language=language_context.requested_response_language,
    )
    if learning_recommendations:
        try:
            recommendation_doc_ids = learning_recommendations[0].get("documentIds") or []
            recommendation_revision_hash = await run_in_threadpool(
                lambda: course_revision_hash(user_id, payload.courseId, recommendation_doc_ids)
            )
            existing_lesson = await run_in_threadpool(
                lambda: find_existing_lesson(
                    user_id=user_id, course_id=payload.courseId,
                    topic=str(learning_recommendations[0].get("topic") or ""),
                    revision_hash=recommendation_revision_hash,
                )
            )
            learning_recommendations[0]["documentRevisionHash"] = recommendation_revision_hash
            if existing_lesson:
                learning_recommendations[0]["existingLessonId"] = existing_lesson.get("id")
                learning_recommendations[0]["existingLessonStatus"] = existing_lesson.get("lesson_status") or "complete"
                learning_recommendations[0]["action"] = {
                    "label": "Continue Deep Learn" if existing_lesson.get("lesson_status") != "complete" else "Open Deep Learn lesson",
                    "type": "open_deep_learn",
                }
        except Exception:
            log.exception("deep learn reuse lookup failed (recommendation remains usable)")
    context_consistent = bool(
        retrieval_scope.exercise_reference == grounded_identity.exercise_reference
        and (
            not retrieval_scope.preferred_pages
            or grounded_identity.resolved_task_page is None
            or grounded_identity.resolved_task_page in retrieval_scope.preferred_pages
        )
        and final_grounding_state.identity.fingerprint()
        == grounded_identity.fingerprint()
        and final_grounding_state.reliability_fingerprint
        == reliability_cache_fingerprint
    )
    if not context_consistent:
        log.error(
            "grounded_context_inconsistent request_id=%s exercise=%s resolved_page=%s",
            request_id,
            grounded_identity.exercise_reference,
            grounded_identity.resolved_task_page,
        )
        return _stream_static_answer(
            text="Minallo could not create a consistent grounded request context.",
            decision=source_decision,
            answer_mode="clarification",
            status_key="identifying_question",
            extra_meta={
                "taskType": grounded_identity.task_kind,
                "errorCode": "grounded_context_inconsistent",
                "terminalEvent": "done",
            },
        )
    grounded_request_context = GroundedRequestContext(
        request_id=request_id,
        task_traits=task_traits,
        task_identity=grounded_identity,
        retrieval_scope=retrieval_scope,
        evidence_requirement=evidence_requirement(
            traits=task_traits,
            current_page_text=payload.openFileContext or "",
            text_quality=assess_text_quality(payload.openFileContext or ""),
            image_count=len(open_file_images),
        ),
        answer_obligations=cache_obligations,
        allowed_mapping_labels=final_grounding_state.allowed_mapping_labels,
        visible_answer_options=grounded_identity.visible_answer_options,
        source_fingerprint=reliability_cache_fingerprint,
    )
    observer.event(
        "grounded_request_context_created",
        exerciseReference=grounded_identity.exercise_reference,
        visiblePage=grounded_identity.visible_page or payload.visiblePage,
        resolvedTaskPage=grounded_identity.resolved_task_page,
        identityResolutionMethod=grounded_identity.identity_resolution_method.value,
        identityEvidencePages=grounded_identity.identity_evidence_pages,
        exerciseVisibleOnPage=grounded_identity.exercise_visible_on_page,
        exerciseVisibleOnVisiblePage=(
            grounded_identity.exercise_visible_on_visible_page
        ),
        exerciseFoundOnResolvedPage=(
            grounded_identity.exercise_found_on_resolved_page
        ),
        visibleOptionCount=len(grounded_identity.visible_answer_options),
        mappingLabelCount=len(grounded_identity.visible_mapping_labels),
        identityConfidence=grounded_identity.source_confidence,
        obligations=[item.obligation_type for item in grounded_request_context.answer_obligations],
    )
    high_risk_validation = _requires_verified_buffering(
        question=resolved_question,
        dialogue_act=dialogue.dialogue_act.value,
        has_visual_evidence=bool(
            open_file_images or selected_text or payload.problemSolver or chunks
        ),
        has_active_numerical_state=bool(
            tutor_state and tutor_state.reusable_results()
        ),
        task_traits=task_traits,
    )
    # Multi-item answers must be buffered until coverage repair is complete,
    # but conceptual lists are not numerical/exercise drafts. Keeping these
    # concerns separate prevents the active-exercise identity validator from
    # replacing a valid ten-section answer with a quantity-mismatch warning.
    coverage_buffering = bool(multi_item_result.evidence)
    buffer_answer_output = high_risk_validation or coverage_buffering
    # Usage checkpoint captured from the generator's internal usageEst event
    # (model + estimated prompt tokens, emitted just before the OpenAI call).
    # Consulted by gen_with_abort_meter when the stream dies early.
    abort_meter: dict[str, Any] = {}

    # weak_topics was fetched above (it feeds the workspace block + cache
    # fingerprint as well as the per-student coaching note in the prompt).

    def gen():
        import json
        event_identity = {
            "requestId": request_id,
            "conversationId": payload.conversationId,
            "assistantMessageId": payload.assistantMessageId,
        }
        observer.start("draft_generated")
        if app_or_workspace:
            yield _status_sse("checking_app_context")
        elif chunks:
            yield _status_sse("collecting_sources")
        else:
            yield _status_sse("writing_answer")
        if high_risk_validation:
            yield _status_sse("checking_values")
        source_zero_context = (selected_text or "").strip()
        if source_zero_context:
            source_zero_context = (
                "SERVER-VERIFIED SELECTED PDF EVIDENCE (Source 0):\n"
                + source_zero_context
            )
        generation_open_context = "\n\n".join(
            item for item in (
                source_zero_context,
                (payload.openFileContext or "").strip(),
            ) if item
        )
        state_overlay = ""
        if tutor_state:
            reusable = [
                {
                    "id": item.id,
                    "question": item.question_id,
                    "value": item.value,
                    "unit": item.unit,
                }
                for item in tutor_state.reusable_results()
            ]
            state_overlay = (
                "\nPERSISTED TUTORING STATE (authoritative):\n"
                f"- Active exercise: {tutor_state.active_question or 'unknown'}\n"
                f"- Document revision: {tutor_state.document_revision or 'unknown'}\n"
                f"- Reusable verified results: {json.dumps(reusable, ensure_ascii=False)}\n"
                "- Never reuse stale or rejected results.\n"
            )
        gen_iter = stream_answer(
            question=question, chunks=chunks, doc_names=doc_name_map,
            tutor_mode=tutor_mode,
            active_file_name=payload.activeFileName,
            open_file_context=generation_open_context or None,
            open_file_images=open_file_images,
            weak_topics=weak_topics,
            previous_turns=previous_turns_payload,
            problem_solver=payload.problemSolver.model_dump() if payload.problemSolver else None,
            workspace_block=workspace_block or None,
            assistant_mode=assistant_mode,
            workspace_question=workspace_question,
            user_id=user_id,
            course_id=payload.courseId,
            # The student's selection is the coverage contract for exam /
            # per-file requests — pass the resolved names so every selected file
            # gets a section and any still-processing ones are reported. The ids
            # also anchor exam-style detection to the real selection, not just
            # whatever chunks retrieval happened to surface.
            selected_file_names=[
                doc_name_map[i] for i in (retrieval_document_ids or []) if i in doc_name_map
            ] or None,
            selected_document_ids=list(retrieval_document_ids) if retrieval_document_ids else None,
            active_document_id=payload.activeDocumentId,
            visible_page=payload.visiblePage,
            request_id=request_id,
            response_language=language_context.requested_response_language,
            grounding_policy=source_decision.grounding_policy.value,
            max_tokens=(
                max(2500, min(12000, len(multi_item_result.manifest.requested_items) * 900))
                if multi_item_result.evidence else 2500
            ),
            request_plan_overlay=(
                answer_plan_overlay(multi_item_result)
                + fallback_research.prompt_overlay()
            ),
            dialogue_overlay=(
                dialogue.prompt_overlay()
                + state_overlay
                + grounded_request_context.prompt_overlay()
                + explanation_plan.prompt_overlay()
            ),
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
                    evt["requestIntent"] = {
                        "primaryIntent": "multi_question" if explicit_questions.question_count > 1 else None,
                        "questionCount": explicit_questions.question_count,
                        "exactScope": explicit_questions.exact_scope,
                        "answerLanguage": language_context.requested_response_language,
                        "visualInterpretation": explicit_questions.contains_visual_reference,
                        "followUpReference": False if explicit_questions.self_contained else None,
                    }
                    evt["retrievalRouting"] = cache_routing_plan.trace()
                    evt["dialogueResolution"] = dialogue.to_api()
                    evt["pedagogicalAnalysis"] = explanation_plan.to_api()
                    evt["learningRecommendations"] = learning_recommendations
                    evt["visualAids"] = visual_aids
                    evt.update(_source_meta(source_decision, cache_hit=False))
                    evt.update(event_identity)
                    evt["event"] = "sources.ready"
                    chunk_bytes = ("data: " + json.dumps(evt, ensure_ascii=False) + "\n\n").encode("utf-8")
                    yield chunk_bytes
                    if visual_aids:
                        yield _sse_bytes(json.dumps({
                            **event_identity, "event": "visual_aids.ready",
                            "visualAids": visual_aids,
                        }, ensure_ascii=False))
                    if learning_recommendations:
                        yield _sse_bytes(json.dumps({
                            **event_identity, "event": "learning_recommendation.ready",
                            "learningRecommendations": learning_recommendations,
                        }, ensure_ascii=False))
                    continue
                if evt.get("t"):
                    evt.update(event_identity)
                    evt["event"] = "answer.delta"
                    chunk_bytes = ("data: " + json.dumps(evt, ensure_ascii=False) + "\n\n").encode("utf-8")
                    full_text_buf.append(evt["t"])
                    if buffer_answer_output:
                        pending_token_events.append(chunk_bytes)
                        continue
                if evt.get("done"):
                    evt["retrievalRouting"] = cache_routing_plan.trace()
                    evt.update(event_identity)
                    evt["event"] = "answer.completed"
                    observer.finish("draft_generated")
                    evt["dialogueResolution"] = dialogue.to_api()
                    evt["pedagogicalAnalysis"] = explanation_plan.to_api()
                    evt["learningRecommendations"] = learning_recommendations
                    evt["visualAids"] = visual_aids
                    if multi_item_result.evidence:
                        original_text = "".join(full_text_buf)
                        completed_text, coverage = ensure_complete_answer(
                            multi_item_result,
                            original_text,
                            allow_general_fallback=policy_allows_general_knowledge(
                                source_decision.grounding_policy,
                            ),
                            fallback_generator=lambda item_question: generate_general_answer(
                                (
                                    f"{item_question}\n\nAnswer this item substantively in the user's language. "
                                    "Include a concise answer, a detailed technical explanation, and satisfy every "
                                    "requested numerical/list constraint. Do not return an evidence placeholder."
                                ),
                                max_tokens=700,
                            )["answer"],
                        )
                        evt["multiItemCoverage"] = {
                            "expectedItemIds": list(coverage.expected_item_ids),
                            "renderedItemIds": list(coverage.rendered_item_ids),
                            "missingItemIds": list(coverage.missing_item_ids),
                            "complete": coverage.complete,
                            "items": [item.__dict__ for item in coverage.item_coverage],
                        }
                        if completed_text != original_text:
                            full_text_buf.clear()
                            full_text_buf.append(completed_text)
                            pending_token_events.clear()
                            yield _sse_bytes(json.dumps(
                                {"t": completed_text}, ensure_ascii=False,
                            ))
                    if tutor_state and automatic_context_section:
                        section_answer = "".join(full_text_buf).strip()
                        tutor_state.recent_section_turns = (
                            tutor_state.recent_section_turns
                            + [{"role": "user", "text": question}]
                            + ([{"role": "assistant", "text": section_answer}]
                               if section_answer else [])
                        )[-16:]
                    verification_payload = evt.get("verification")
                    task_type = str(evt.get("taskType") or "standard_qa")
                    critical_reject = _verification_requires_rejection(
                        verification_payload,
                        task_type=task_type,
                    )
                    observer.event(
                        "deterministic_validation_completed",
                        result="failed" if critical_reject else "passed",
                    )
                    from ..services.answer_stream import answer_matches_resolved_language  # noqa: WPS433
                    wrong_language = not answer_matches_resolved_language(
                        "".join(full_text_buf),
                        language_context.requested_response_language,
                        preserve_source_labels=task_type in {
                            "visual_assignment",
                            "checkbox_grid",
                            "labelled_diagram",
                            "technical_drawing",
                            "matching_table",
                        },
                    )
                    unsafe_model_downgrade = bool(
                        high_risk_validation and evt.get("heavyCapped")
                    )
                    from ..services.reliability import (  # noqa: WPS433
                        compare_task_identities,
                        identify_draft_task,
                        validate_repaired_answer,
                    )
                    from ..services.answer_stream import required_number_range  # noqa: WPS433
                    required_range = required_number_range(
                        resolved_question, generation_open_context,
                    )
                    draft_identity = identify_draft_task("".join(full_text_buf))
                    semantic_mismatches = compare_task_identities(
                        grounded_identity,
                        draft_identity,
                        traits=task_traits,
                    )
                    draft_contract = validate_repaired_answer(
                        answer="".join(full_text_buf),
                        identity=grounded_request_context.task_identity,
                        traits=grounded_request_context.task_traits,
                        required_identifiers=[str(value) for value in (required_range or [])],
                        allowed_source_labels=(
                            [item.canonical for item in grounded_request_context.allowed_mapping_labels]
                            or grounded_request_context.task_identity.option_texts()
                        ),
                    )
                    obligation_failures = [
                        item.obligation_type for item in draft_contract.obligations
                        if not item.satisfied
                    ]
                    if (semantic_mismatches or obligation_failures) and high_risk_validation:
                        from ..services.visual_repair import (  # noqa: WPS433
                            generate_grounded_repair_sync,
                        )
                        regrounded = generate_grounded_repair_sync(
                            request_id=request_id,
                            question=resolved_question,
                            incorrect_draft="".join(full_text_buf),
                            image_parts=open_file_images,
                            source_context=(
                                generation_open_context
                                + grounded_request_context.prompt_overlay()
                            ),
                            mismatch_codes=(
                                [item.value for item in semantic_mismatches]
                                + obligation_failures
                            ),
                        )
                        repaired_mismatches = (
                            compare_task_identities(
                                grounded_identity,
                                identify_draft_task(regrounded),
                                traits=task_traits,
                            )
                            if regrounded else semantic_mismatches
                        )
                        repaired_contract = validate_repaired_answer(
                            answer=regrounded or "",
                            identity=grounded_request_context.task_identity,
                            traits=grounded_request_context.task_traits,
                            required_identifiers=[str(value) for value in (required_range or [])],
                            allowed_source_labels=(
                                [item.canonical for item in grounded_request_context.allowed_mapping_labels]
                                or grounded_request_context.task_identity.option_texts()
                            ),
                        )
                        if regrounded and not repaired_mismatches and repaired_contract.accepted:
                            full_text_buf.clear()
                            full_text_buf.append(regrounded)
                            pending_token_events.clear()
                            yield _sse_bytes(json.dumps({"t": regrounded}, ensure_ascii=False))
                            evt["semanticRepair"] = True
                            evt["repairAttempts"] = int(evt.get("repairAttempts") or 0) + 1
                            semantic_mismatches = []
                            obligation_failures = []
                        evt["semanticMismatch"] = (
                            [item.value for item in semantic_mismatches] or None
                        )
                        evt["unsatisfiedObligations"] = obligation_failures or None
                    false_visual_denial = bool(
                        open_file_images
                        and _FALSE_VISUAL_DENIAL_RE.search("".join(full_text_buf))
                    )
                    if (semantic_mismatches or obligation_failures) and high_risk_validation:
                        safe_text = (
                            "Minallo could not reliably match the draft to the active "
                            "exercise and requested quantity. The draft was not shown."
                        )
                        full_text_buf.clear()
                        full_text_buf.append(safe_text)
                        pending_token_events.clear()
                        yield _sse_bytes(json.dumps({"t": safe_text}, ensure_ascii=False))
                        evt["confidence"] = "low"
                        evt["unsupported"] = True
                        evt["recovery"] = {
                            "code": "task_identity_mismatch",
                            "action": "reground_active_document",
                        }
                    elif false_visual_denial:
                        from ..services.visual_repair import (  # noqa: WPS433
                            repair_false_visual_denial_sync,
                        )
                        repaired = repair_false_visual_denial_sync(
                            request_id=request_id,
                            question=resolved_question,
                            draft="".join(full_text_buf),
                            visible_page=payload.visiblePage,
                            open_context=generation_open_context,
                            image_parts=open_file_images,
                        )
                        repaired_verification = None
                        if repaired:
                            try:
                                from ..services.verification import verify_answer  # noqa: WPS433
                                repaired_verification = verify_answer(
                                    answer_text=repaired,
                                    chunk_texts=[
                                        generation_open_context,
                                        *[
                                            str(getattr(chunk, "text", "") or "")
                                            for chunk in chunks
                                        ],
                                    ],
                                    question=resolved_question,
                                    answer_mode=str(evt.get("answerMode") or "math"),
                                    allowed_filenames=[
                                        name for name in doc_name_map.values() if name
                                    ],
                                ).to_api()
                            except Exception:
                                log.exception(
                                    "visual_repair_verification_unavailable request_id=%s",
                                    request_id,
                                )
                        repair_validation = validate_repaired_answer(
                            answer=repaired or "",
                            identity=grounded_request_context.task_identity,
                            traits=grounded_request_context.task_traits,
                            required_identifiers=[
                                str(value) for value in (required_range or [])
                            ],
                            allowed_source_labels=(
                                [item.canonical for item in grounded_request_context.allowed_mapping_labels]
                                or grounded_request_context.task_identity.option_texts()
                            ),
                            verification_rejected=bool(
                                repaired_verification
                                and _verification_requires_rejection(
                                    repaired_verification,
                                    task_type=task_type,
                                )
                            ),
                        )
                        repair_succeeded = bool(
                            repaired
                            and not _FALSE_VISUAL_DENIAL_RE.search(repaired)
                            and repair_validation.accepted
                        )
                        safe_text = repaired if repair_succeeded else (
                            "The current page image was attached, but Minallo "
                            "could not read the requested visual content reliably."
                        )
                        full_text_buf.clear()
                        full_text_buf.append(safe_text)
                        pending_token_events.clear()
                        yield _sse_bytes(json.dumps({"t": safe_text}, ensure_ascii=False))
                        evt["confidence"] = evt.get("confidence") if repair_succeeded else "low"
                        evt["unsupported"] = not repair_succeeded
                        evt["visualDenialGuard"] = (
                            "repaired" if repair_succeeded else "repair_failed"
                        )
                        evt["repairAttempts"] = 1
                        evt["repairValidation"] = {
                            "accepted": repair_validation.accepted,
                            "mismatches": [
                                item.value for item in repair_validation.mismatches
                            ],
                            "unsatisfiedObligations": [
                                item.obligation_type
                                for item in repair_validation.obligations
                                if not item.satisfied
                            ],
                        }
                        if repair_succeeded and repaired_verification:
                            evt["verification"] = repaired_verification
                            verification_payload = repaired_verification
                        observer.event(
                            "repair_completed",
                            repairAttempts=1,
                            success=repair_succeeded,
                        )
                        log.warning(
                            "false_visual_denial_repair request_id=%s visible_page=%s success=%s",
                            request_id,
                            payload.visiblePage,
                            repair_succeeded,
                        )
                    elif unsafe_model_downgrade:
                        safe_text = (
                            "This technical question requires Minallo's stronger "
                            "visual verification model, which is temporarily unavailable."
                        )
                        full_text_buf.clear()
                        full_text_buf.append(safe_text)
                        pending_token_events.clear()
                        yield _sse_bytes(json.dumps({"t": safe_text}, ensure_ascii=False))
                        evt["answerMode"] = "strong_model_required"
                        evt["confidence"] = "low"
                        evt["unsupported"] = True
                        evt["recovery"] = {
                            "code": "strong_model_required",
                            "action": "retry_when_available",
                        }
                    elif high_risk_validation and wrong_language:
                        if payload.conversationId and generation is not None:
                            from ..services.tutor_state_store import (  # noqa: WPS433
                                current_persisted_generation,
                            )
                            if current_persisted_generation(
                                user_id, payload.conversationId
                            ) != generation:
                                pending_token_events.clear()
                                yield _error_sse(
                                    code="request_superseded",
                                    message="This request was replaced by a newer question.",
                                    retryable=False,
                                    request_id=request_id,
                                )
                                return
                        from ..services.answer_stream import (  # noqa: WPS433
                            rewrite_answer_in_resolved_language,
                        )
                        rewrite_evidence = "\n\n".join(
                            [
                                generation_open_context,
                                *[
                                    str(getattr(chunk, "text", "") or "")
                                    for chunk in chunks
                                ],
                            ]
                        )
                        try:
                            rewritten = rewrite_answer_in_resolved_language(
                                "".join(full_text_buf),
                                language_context.requested_response_language,
                                evidence=rewrite_evidence,
                            )
                        except Exception:
                            log.exception(
                                "language_rewrite_failed request_id=%s",
                                request_id,
                            )
                            rewritten = ""
                        rewrite_valid = answer_matches_resolved_language(
                            rewritten,
                            language_context.requested_response_language,
                            preserve_source_labels=task_type in {
                                "visual_assignment",
                                "checkbox_grid",
                                "labelled_diagram",
                                "technical_drawing",
                                "matching_table",
                            },
                        )
                        rewritten_verification = None
                        if rewrite_valid:
                            try:
                                from ..services.verification import verify_answer  # noqa: WPS433

                                rewritten_verification = verify_answer(
                                    answer_text=rewritten,
                                    chunk_texts=[
                                        generation_open_context,
                                        *[
                                            str(
                                                getattr(chunk, "text", "") or ""
                                            )
                                            for chunk in chunks
                                        ],
                                    ],
                                    question=resolved_question,
                                    answer_mode=str(
                                        evt.get("answerMode") or "math"
                                    ),
                                    allowed_filenames=[
                                        name
                                        for name in doc_name_map.values()
                                        if name
                                    ],
                                ).to_api()
                            except Exception:
                                log.exception(
                                    "language_rewrite_verification_failed request_id=%s",
                                    request_id,
                                )
                        if (
                            rewrite_valid
                            and rewritten_verification
                            and _verification_is_cacheable(
                                rewritten_verification,
                                task_type=task_type,
                                task_identity=grounded_identity,
                            )
                        ):
                            full_text_buf.clear()
                            full_text_buf.append(rewritten)
                            pending_token_events.clear()
                            yield _sse_bytes(json.dumps({
                                "t": rewritten,
                            }, ensure_ascii=False))
                            evt["verification"] = rewritten_verification
                            verification_payload = rewritten_verification
                            wrong_language = False
                            evt["languageRewritten"] = True
                        else:
                            # Language classification is advisory after the
                            # repair attempt. Grounded educational answers can
                            # legitimately contain long source-language quotes;
                            # never discard that usable answer or trap the user
                            # in a retry loop solely on detector uncertainty.
                            for pending in pending_token_events:
                                yield pending
                            pending_token_events.clear()
                            evt["languageStatus"] = "unverified_mixed_source"
                            evt["languageRewritten"] = False
                            log.warning(
                                "wrong_language_output_allowed request_id=%s expected=%s",
                                request_id,
                                language_context.requested_response_language,
                            )
                    elif high_risk_validation and critical_reject:
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
                    elif buffer_answer_output:
                        for pending in pending_token_events:
                            yield pending
                        pending_token_events.clear()
                    captured_meta.update(evt)
                    observer.event(
                        "semantic_contradiction_check_completed",
                        semanticMismatch=evt.get("semanticMismatch"),
                    )
                    observer.event(
                        "visual_verification_completed",
                        result=(
                            verification_payload.get("status")
                            if isinstance(verification_payload, dict)
                            else "unavailable"
                        ),
                    )
                    observer.event("final_answer_emitted")
                    observer.event("terminal_event_emitted", terminalEvent="done")
                    from ..services.request_generation import is_current_generation  # noqa: WPS433
                    if not is_current_generation(
                        user_id, payload.conversationId, payload.conversationGeneration
                    ):
                        pending_token_events.clear()
                        yield _error_sse(
                            code="request_superseded",
                            message="This request was replaced by a newer question.",
                            retryable=False,
                            request_id=request_id,
                        )
                        return
                    if payload.conversationId and generation is not None:
                        from ..services.tutor_state_store import (  # noqa: WPS433
                            current_persisted_generation,
                        )
                        try:
                            persisted_generation = current_persisted_generation(
                                user_id, payload.conversationId
                            )
                        except Exception:
                            log.exception(
                                "shared_generation_check_failed request_id=%s",
                                request_id,
                            )
                            pending_token_events.clear()
                            yield _error_sse(
                                code="shared_generation_check_failed",
                                message="The request state could not be confirmed.",
                                retryable=True,
                                request_id=request_id,
                            )
                            return
                        if persisted_generation != generation:
                            pending_token_events.clear()
                            yield _error_sse(
                                code="request_superseded",
                                message="This request was replaced by a newer question.",
                                retryable=False,
                                request_id=request_id,
                            )
                            return
                    if (
                        tutor_state
                        and not wrong_language
                        and not critical_reject
                        and not unsafe_model_downgrade
                        and _verification_is_cacheable(
                            verification_payload,
                            task_type=task_type,
                            task_identity=grounded_identity,
                        )
                    ):
                        if payload.activeDocumentId:
                            try:
                                _verify_user_owns_documents(
                                    user_id, payload.courseId, [payload.activeDocumentId]
                                )
                            except HTTPException:
                                pending_token_events.clear()
                                log.warning(
                                    "authorization_revoked_before_persistence request_id=%s",
                                    request_id,
                                )
                                yield _error_sse(
                                    code="document_access_revoked",
                                    message="Document access changed during this request.",
                                    retryable=False,
                                    request_id=request_id,
                                )
                                return
                        from ..services.tutor_state import (  # noqa: WPS433
                            VerifiedGroundedContext,
                            VerifiedResult,
                        )
                        from ..services.tutor_state_store import save_tutor_state  # noqa: WPS433
                        structured_results = (
                            verification_payload.get("verifiedResults")
                            if isinstance(verification_payload, dict)
                            else None
                        ) or []
                        for position, raw_result in enumerate(structured_results):
                            if not isinstance(raw_result, dict):
                                continue
                            value = str(raw_result.get("value") or "").strip()
                            if not value:
                                continue
                            result_id = str(
                                raw_result.get("id")
                                or (
                                    f"{tutor_state.active_question or 'turn'}:"
                                    f"{raw_result.get('quantity') or position}"
                                )
                            )
                            tutor_state.add_verified_result(VerifiedResult(
                                id=result_id,
                                document_id=(
                                    tutor_state.document_id
                                    or payload.activeDocumentId
                                    or ""
                                ),
                                document_revision=(
                                    tutor_state.document_revision
                                    or payload.viewerRevision
                                    or ""
                                ),
                                exam_variant=tutor_state.exam_variant,
                                question_id=(
                                    tutor_state.active_question or result_id
                                ),
                                value=value,
                                unit=(
                                    str(raw_result.get("unit")).strip()
                                    if raw_result.get("unit") is not None
                                    else None
                                ),
                                formula=(
                                    str(raw_result.get("formula")).strip()
                                    if raw_result.get("formula") is not None
                                    else None
                                ),
                                quantity=(
                                    str(raw_result.get("quantity")).strip()
                                    if raw_result.get("quantity") is not None
                                    else None
                                ),
                                assumptions=tuple(
                                    str(item)
                                    for item in (
                                        raw_result.get("assumptions") or []
                                    )
                                    if str(item).strip()
                                ),
                                verification={
                                    "status": verification_payload.get("status"),
                                    "details": verification_payload.get("details"),
                                },
                                derived_from_evidence_ids=(
                                    (selected_region_id,)
                                    if selected_region_id
                                    else ()
                                ),
                                derived_from_result_ids=tuple(
                                    str(item)
                                    for item in (
                                        raw_result.get(
                                            "derivedFromResultIds"
                                        ) or []
                                    )
                                ),
                                source_priority=(
                                    "selected_region"
                                    if selected_region_id
                                    else "active_question"
                                ),
                            ))
                        tutor_state.model_version = str(evt.get("model") or "") or None
                        tutor_state.grounded_context = VerifiedGroundedContext(
                            document_id=payload.activeDocumentId or "",
                            page=payload.visiblePage,
                            exercise_reference=grounded_identity.exercise_reference,
                            domain=grounded_identity.domain,
                            requested_quantities=grounded_identity.requested_quantities,
                            task_kind=grounded_identity.task_kind,
                            source_fingerprint=grounded_identity.fingerprint(),
                            verified=True,
                            verification_status=str(
                                verification_payload.get("status") or "verified"
                            ),
                        )
                        try:
                            save_tutor_state(user_id, payload.courseId, tutor_state)
                        except Exception:
                            log.exception(
                                "tutor_state save rejected request_id=%s generation=%s",
                                request_id, generation,
                            )
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
                    if verified_region and payload.activeDocumentId:
                        sources_js.append(
                            verified_region.citation(
                                doc_name_map.get(payload.activeDocumentId)
                                or payload.activeFileName
                                or "Selected PDF"
                            )
                        )
                    for s in (evt.get("sources") or []):
                        if (
                            verified_region
                            and isinstance(s, dict)
                            and s.get("index") == 0
                        ):
                            continue
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
                    sources_js.extend(_web_sources_to_js(fallback_research.sources))
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
        cache_verified = _verification_is_cacheable(
            cached_verification,
            task_type=str(captured_meta.get("taskType") or "standard_qa"),
            task_identity=grounded_identity,
        )
        if (
            version_hash
            and full_text_buf
            and cache_verified
            and not captured_meta.get("heavyCapped")
            and not captured_meta.get("recovery")
            and not fallback_research.sources
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
                        "groundingPolicy": captured_meta.get("groundingPolicy"),
                        "pedagogicalAnalysis": captured_meta.get("pedagogicalAnalysis"),
                        "learningRecommendations": captured_meta.get("learningRecommendations") or [],
                        "visualAids": captured_meta.get("visualAids") or [],
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

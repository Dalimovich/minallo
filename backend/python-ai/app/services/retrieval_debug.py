"""Phase 2 — retrieval observability.

Records one row per AI/RAG request to public.retrieval_debug_log so we can
inspect later: what was asked, which docs were considered, what came back,
and what made it into the prompt.

Design rules:
- Best-effort. A logging failure must never break the user-facing request.
- Metadata only. Chunks are reduced to small excerpts (≤200 chars) so we
  never duplicate full document context into another table.
- Synchronous insert (Supabase python client is sync). Cheap because the
  row is small and we only write one per request.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_EXCERPT_MAX = 200


def _excerpt(text: str | None) -> str:
    if not text:
        return ""
    t = text.strip().replace("\n", " ")
    return t if len(t) <= _EXCERPT_MAX else t[: _EXCERPT_MAX - 1] + "…"


def chunk_to_meta(chunk: Any) -> dict[str, Any]:
    """Reduce a RetrievedChunk (or already-dict payload) to a JSON-safe
    metadata record suitable for the debug log."""
    if isinstance(chunk, dict):
        get = chunk.get
    else:
        get = lambda k, d=None: getattr(chunk, k, d)  # noqa: E731

    return {
        "chunkId":      get("chunk_id") or get("chunkId"),
        "documentId":   get("document_id") or get("documentId"),
        "pageStart":    get("page_start") if get("page_start") is not None else get("pageStart"),
        "pageEnd":      get("page_end") if get("page_end") is not None else get("pageEnd"),
        "score":        get("score"),
        "similarity":   get("similarity"),
        "chunkType":    get("chunk_type") or get("chunkType"),
        "sectionTitle": get("section_title") or get("sectionTitle"),
        "excerpt":      _excerpt(get("text")),
    }


@dataclass
class DebugPayload:
    user_id: str
    course_id: str
    endpoint: str                       # 'ask' | 'ask-stream' | 'retrieve-context'
    question: str
    active_document_id: str | None
    selected_document_ids: list[str] | None
    retrieval_strategy: str | None
    retrieval_mode: str | None          # 'strong' | 'weak' | 'none'
    candidate_doc_count: int | None
    exercise_hit: dict[str, Any] | None
    chunks: Iterable[Any]
    model: str | None = None
    cache_hit: bool = False
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    duration_ms: int | None = None
    error: str | None = None


def record_retrieval_debug(p: DebugPayload) -> None:
    """Insert one row. Swallows all errors — logging must never break /ask."""
    try:
        row = {
            "user_id":               p.user_id,
            "course_id":             p.course_id,
            "endpoint":              p.endpoint,
            "question":              (p.question or "")[:2000],
            "active_document_id":    p.active_document_id,
            "selected_document_ids": p.selected_document_ids or [],
            "retrieval_strategy":    p.retrieval_strategy,
            "retrieval_mode":        p.retrieval_mode,
            "candidate_doc_count":   p.candidate_doc_count,
            "exercise_hit":          p.exercise_hit,
            "chunk_metadata":        [chunk_to_meta(c) for c in (p.chunks or [])],
            "model":                 p.model,
            "cache_hit":             p.cache_hit,
            "prompt_tokens":         p.prompt_tokens,
            "completion_tokens":     p.completion_tokens,
            "duration_ms":           p.duration_ms,
            "error":                 p.error,
        }
        get_supabase().table("retrieval_debug_log").insert(row).execute()
    except Exception:  # noqa: BLE001
        log.exception("retrieval_debug insert failed (non-fatal)")

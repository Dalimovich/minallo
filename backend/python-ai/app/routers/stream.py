"""POST /ask-stream — SSE-streamed RAG answer for the browser.

Browser hits this directly with the Supabase JWT in the Authorization
header. We verify the JWT against Supabase's auth API, then stream
tokens as they arrive from OpenAI. This bypasses Netlify entirely, so
the 30s function timeout never applies.

Reuses /ask's retrieval + ownership + cache logic.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..jwt_auth import verify_supabase_jwt
from ..services.answer_stream import stream_answer
from ..services.cache import fetch_document_version_hash, lookup_answer, save_answer
from ..services.retrieval import retrieve_chunks, retrieve_exercise_block
from ..services.retrieval_debug import DebugPayload, record_retrieval_debug
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["ask-stream"])

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


class AskStreamRequest(BaseModel):
    courseId: str
    documentIds: list[str] | None = None
    activeDocumentId: str | None = None
    question: str
    bypassCache: bool = False


def _sse_bytes(payload: str) -> bytes:
    return ("data: " + payload + "\n\n").encode("utf-8")


@router.post("/ask-stream")
async def ask_stream_endpoint(payload: AskStreamRequest, user: dict = Depends(verify_supabase_jwt)):
    user_id = user["id"]
    if payload.documentIds:
        for did in payload.documentIds:
            _require_uuid(did, "documentId")
    if payload.activeDocumentId:
        _require_uuid(payload.activeDocumentId, "activeDocumentId")
    doc_name_map = _verify_user_owns_documents(user_id, payload.courseId, payload.documentIds)
    if payload.activeDocumentId:
        doc_name_map.update(_verify_user_owns_documents(
            user_id, payload.courseId, [payload.activeDocumentId]
        ))

    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is required")

    # ── Cache check (same logic as /ask) ─────────────────────────────────────
    version_hash = ""
    cached = None
    if payload.documentIds and not payload.bypassCache:
        version_hash = fetch_document_version_hash(user_id, payload.courseId, payload.documentIds)
        cached = lookup_answer(
            user_id=user_id, course_id=payload.courseId,
            question=question, version_hash=version_hash,
        )

    def cached_stream():
        # Emit the cached answer in a single 'done' event so the client
        # renders it without setup overhead.
        import json
        yield _sse_bytes(json.dumps({
            "meta": True,
            "retrievalMode": cached.get("retrievalMode", "strong"),
            "confidence": "high" if cached.get("retrievalMode") == "strong" else "low",
            "unsupported": cached.get("retrievalMode") != "strong",
        }))
        # Send the answer as one token so the existing client loop renders it.
        yield _sse_bytes(json.dumps({"t": cached.get("answer", "")}))
        # Translate Python-shape groundedSources to the JS-frontend shape.
        sources_js = []
        for s in (cached.get("groundedSources") or []):
            page_start = s.get("pageStart")
            page_end = s.get("pageEnd")
            pages = None
            if page_start and page_end:
                pages = str(page_start) if page_start == page_end else f"{page_start}-{page_end}"
            elif page_start:
                pages = str(page_start)
            sources_js.append({
                "file_name": s.get("fileName") or "Unknown",
                "pages": pages,
                "section": s.get("sectionTitle"),
            })
        yield _sse_bytes(json.dumps({
            "done": True,
            "retrievalMode": cached.get("retrievalMode", "strong"),
            "confidence": "high" if cached.get("retrievalMode") == "strong" else "low",
            "unsupported": cached.get("retrievalMode") != "strong",
            "sources": sources_js,
            "cacheHit": True,
            "model": cached.get("model"),
        }))

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
        ))
        return StreamingResponse(cached_stream(), media_type="text/event-stream")

    # ── Retrieve ─────────────────────────────────────────────────────────────
    exercise_hit = retrieve_exercise_block(
        user_id=user_id, course_id=payload.courseId, query=question,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
    )
    chunks = retrieve_chunks(
        user_id=user_id, course_id=payload.courseId,
        query=question, document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId, top_k=12,
    )
    if exercise_hit:
        from .ask import _prepend_exercise_chunks  # reuse the same helper
        chunks = _prepend_exercise_chunks(exercise_hit, chunks)

    missing_ids = [c.document_id for c in chunks if c.document_id not in doc_name_map]
    if missing_ids:
        sb = get_supabase()
        try:
            resp = sb.table("documents").select("id, file_name").in_("id", list(set(missing_ids))).execute()
            for row in resp.data or []:
                doc_name_map[row["id"]] = row["file_name"]
        except Exception:
            log.exception("doc_name backfill failed")

    # ── Stream + save to cache on finish ─────────────────────────────────────
    full_text_buf: list[str] = []
    captured_meta: dict[str, Any] = {}

    def gen():
        import json
        gen_iter = stream_answer(
            question=question, chunks=chunks, doc_names=doc_name_map,
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
                if evt.get("t"):
                    full_text_buf.append(evt["t"])
                if evt.get("done"):
                    captured_meta.update(evt)
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
                        })
                    evt["sources"] = sources_js
                    evt["cacheHit"] = False
                    chunk_bytes = ("data: " + json.dumps(evt, ensure_ascii=False) + "\n\n").encode("utf-8")
            yield chunk_bytes

        # After the generator finishes, persist to cache.
        if version_hash and not payload.bypassCache and full_text_buf:
            try:
                save_answer(
                    user_id=user_id, course_id=payload.courseId,
                    question=question, version_hash=version_hash,
                    answer_json={
                        "answer": "".join(full_text_buf),
                        "retrievalMode": captured_meta.get("retrievalMode", "strong"),
                        "groundedSources": [
                            {
                                "fileName": s.get("file_name"),
                                "pageStart": None,  # JS-shape source — page_start fused into 'pages' string
                                "pageEnd": None,
                                "sectionTitle": s.get("section"),
                            }
                            for s in (captured_meta.get("sources") or [])
                        ],
                        "model": captured_meta.get("model"),
                        "promptTokens": captured_meta.get("promptTokens"),
                        "completionTokens": captured_meta.get("completionTokens"),
                    },
                )
            except Exception:
                log.exception("cache save after stream failed (non-fatal)")

        record_retrieval_debug(DebugPayload(
            user_id=user_id, course_id=payload.courseId,
            endpoint="ask-stream", question=question,
            active_document_id=payload.activeDocumentId,
            selected_document_ids=payload.documentIds,
            retrieval_strategy=("exercise-exact+vector" if exercise_hit else "vector+bm25"),
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
            chunks=chunks,
            model=captured_meta.get("model"), cache_hit=False,
            prompt_tokens=captured_meta.get("promptTokens"),
            completion_tokens=captured_meta.get("completionTokens"),
        ))

    return StreamingResponse(gen(), media_type="text/event-stream")

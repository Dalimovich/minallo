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
from ..services.access_control import (
    enforce_interactive_cap,
    enforce_rate_limit,
    require_active_subscription,
)
from ..services.answer import DEFAULT_TUTOR_MODE, normalise_tutor_mode
from ..services.answer_stream import stream_answer
from ..services.cache import fetch_document_version_hash, lookup_answer, save_answer
from ..services.retrieval import retrieve_chunks, retrieve_exercise_block, retrieve_formula_block
from ..services.retrieval_debug import DebugPayload, record_retrieval_debug
from ..supabase_client import get_supabase

# Same hourly cap as the Netlify /api/ai/ask path so the two surfaces share
# one budget. Override via env if needed; defaults to 30/hour to leave headroom
# for the new tighter limits and stay well inside per-user cost expectations.
_ASK_STREAM_RATE_LIMIT_MAX = 30
_ASK_STREAM_RATE_LIMIT_WINDOW_SECONDS = 60 * 60
_MAX_STREAM_QUESTION_CHARS = 8000
_MAX_STREAM_OPEN_FILE_CTX_CHARS = 20000
# Mirror backend/lib/rate-limit.ts INTERACTIVE_MONTHLY_CAP. /ask-stream is an
# interactive RAG call (cheap per request on gpt-4o-mini) so it lives in the
# interactive bucket alongside /api/ai/ask and the writing coach.
_INTERACTIVE_MONTHLY_CAP = 2000

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


class AskStreamRequest(BaseModel):
    courseId: str
    documentIds: list[str] | None = None
    activeDocumentId: str | None = None
    question: str
    # The file name + a slice of text from whatever the user is currently
    # looking at in the PDF reader. Surfaced into the user message so the
    # model can ground "this question / this section" references even when
    # retrieval doesn't surface the exact chunk. Both optional.
    activeFileName: str | None = None
    openFileContext: str | None = None
    # Tutor-mode overlay: explain | solve | quiz. Defaults to 'solve'.
    tutorMode: str | None = None
    # Short transcript of the most recent turns in this chat session,
    # newest last. Capped on the server (we trim to ~3 turns / ~2000 chars
    # total) so the prompt size stays predictable even if the client
    # sends a long history.
    previousTurns: list[PreviousTurn] | None = None
    problemSolver: ProblemSolverPayload | None = None
    # bypassCache is intentionally NOT exposed on the public API. The cache
    # is keyed by document_version_hash so it invalidates automatically when
    # documents change; letting the client opt out defeats the single biggest
    # cost mitigation. Any field the client sends is ignored.


def _sse_bytes(payload: str) -> bytes:
    return ("data: " + payload + "\n\n").encode("utf-8")


@router.post("/ask-stream")
async def ask_stream_endpoint(payload: AskStreamRequest, user: dict = Depends(verify_supabase_jwt)):
    user_id = user["id"]
    # Paid feature — verify subscription before doing anything expensive.
    require_active_subscription(user_id, "ask_stream")
    enforce_interactive_cap(user_id, _INTERACTIVE_MONTHLY_CAP)
    enforce_rate_limit(
        user_id,
        "ask_stream",
        _ASK_STREAM_RATE_LIMIT_MAX,
        _ASK_STREAM_RATE_LIMIT_WINDOW_SECONDS,
        "AI request limit reached. Please try again later.",
    )

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
    if len(question) > _MAX_STREAM_QUESTION_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="question is too long")

    tutor_mode = normalise_tutor_mode(payload.tutorMode or DEFAULT_TUTOR_MODE)
    if payload.openFileContext and len(payload.openFileContext) > _MAX_STREAM_OPEN_FILE_CTX_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="openFileContext is too long")

    # ── Cache check (same logic as /ask) ─────────────────────────────────────
    # When the request carries openFileContext (the user is reading a PDF
    # and asking "this question / this section"), the answer is bound to
    # whatever page is visible — not just the document set. Bypass cache to
    # avoid returning a previous answer composed against a different page.
    version_hash = ""
    cached = None
    has_open_ctx = bool(payload.openFileContext and payload.openFileContext.strip())
    # Cache only makes sense for the legacy 'explain' mode. 'solve' is
    # conversational and 'quiz' is generative, so we never want to serve
    # a stale answer for either. Also bypass cache for deictic questions
    # ("explain this", "warum hier") even in explain mode — the answer
    # depends on the visible PDF section which we're now folding into the
    # cache key anyway, but skipping the lookup is faster.
    from ..services.answer_stream import _is_deictic_question  # noqa: WPS433
    cacheable = (
        tutor_mode == "explain"
        and not _is_deictic_question(question)
        and payload.problemSolver is None
    )
    if payload.documentIds and not has_open_ctx and cacheable:
        version_hash = fetch_document_version_hash(user_id, payload.courseId, payload.documentIds)
        # Previous turns fingerprint into cache key — two students asking
        # "explain that again" in different sessions must not collide.
        _prev_for_cache = [
            {"role": t.role, "text": t.text}
            for t in (payload.previousTurns or [])
        ]
        cached = lookup_answer(
            user_id=user_id, course_id=payload.courseId,
            question=question, version_hash=version_hash,
            tutor_mode=tutor_mode,
            active_document_id=payload.activeDocumentId,
            # Streaming path: visibleContext == openFileContext when set.
            # has_open_ctx is False here (cache only checked when not),
            # but pass it through for symmetry — if a future codepath
            # caches with open context, the key reflects it.
            visible_context=payload.openFileContext,
            previous_turns=_prev_for_cache,
        )

    def cached_stream():
        # Emit the cached answer in a single 'done' event so the client
        # renders it without setup overhead.
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
        yield _sse_bytes(json.dumps({
            "meta": True,
            "retrievalMode": cached.get("retrievalMode", "strong"),
            "confidence": cached_confidence,
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
            "confidence": cached_confidence,
            "verification": cached_v or None,
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

    # Normalise previousTurns from pydantic models → plain dicts before
    # retrieval (so the follow-up rewriter below can use it) and before
    # passing into the service layer.
    previous_turns_payload: list[dict[str, str]] = []
    if payload.previousTurns:
        for t in payload.previousTurns:
            previous_turns_payload.append({"role": t.role, "text": t.text})

    # ── Retrieve ─────────────────────────────────────────────────────────────
    # When the Problem Solver is active, the visible `question` is just a
    # short label ("Problem Solver — Hint mode"). Use the structured problem
    # text for retrieval so embeddings target the actual exercise, not the
    # label. Intentionally exclude `studentWork` from the retrieval query —
    # a student's mistaken equation would pull in irrelevant chunks.
    retrieval_query = (
        (payload.problemSolver.problem or question).strip()
        if payload.problemSolver else question
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
    exercise_hit = retrieve_exercise_block(
        user_id=user_id, course_id=payload.courseId, query=retrieval_query,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
    )
    chunks = retrieve_chunks(
        user_id=user_id, course_id=payload.courseId,
        query=retrieval_query, document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId, top_k=12,
    )
    if exercise_hit:
        from .ask import _prepend_exercise_chunks  # reuse the same helper
        chunks = _prepend_exercise_chunks(exercise_hit, chunks)

    formula_hits = retrieve_formula_block(
        user_id=user_id, course_id=payload.courseId, query=retrieval_query,
        document_ids=payload.documentIds,
        active_document_id=payload.activeDocumentId,
    )
    if formula_hits:
        from .ask import _prepend_formula_chunks  # reuse the same helper
        chunks = _prepend_formula_chunks(formula_hits, chunks)

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

    # Phase 3: per-student weak-topic coaching note. Best-effort; failure
    # here must never block answering.
    from ..services.mastery import fetch_weak_topics  # noqa: WPS433
    weak_topics = fetch_weak_topics(user_id, payload.courseId)

    def gen():
        import json
        gen_iter = stream_answer(
            question=question, chunks=chunks, doc_names=doc_name_map,
            tutor_mode=tutor_mode,
            active_file_name=payload.activeFileName,
            open_file_context=payload.openFileContext,
            weak_topics=weak_topics,
            previous_turns=previous_turns_payload,
            problem_solver=payload.problemSolver.model_dump() if payload.problemSolver else None,
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
        if version_hash and full_text_buf:
            try:
                save_answer(
                    user_id=user_id, course_id=payload.courseId,
                    question=question, version_hash=version_hash,
                    tutor_mode=tutor_mode,
                    active_document_id=payload.activeDocumentId,
                    visible_context=payload.openFileContext,
                    previous_turns=previous_turns_payload,
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
            chunks=chunks,
            model=captured_meta.get("model"), cache_hit=False,
            prompt_tokens=captured_meta.get("promptTokens"),
            completion_tokens=captured_meta.get("completionTokens"),
        ))

    return StreamingResponse(gen(), media_type="text/event-stream")

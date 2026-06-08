"""Small auxiliary endpoints: /feedback and /evaluate-retrieval.

These were the last AI-adjacent JS handlers (ai-feedback.js,
ai-evaluate.js). Both are simple enough that they live in one file.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth import require_internal_token
from ..services.answer import generate_answer
from ..services.retrieval import retrieve_chunks
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["misc"], dependencies=[Depends(require_internal_token)])


# ── /feedback ────────────────────────────────────────────────────────────────


_VALID_RATINGS = {
    "helpful", "not_helpful", "wrong_answer", "not_in_lecture",
    "missing_citation", "wrong_formula", "too_vague", "wrong_language",
}


class FeedbackRequest(BaseModel):
    userId: str
    courseId: str
    question: str
    rating: str
    answerCacheId: str | None = None
    feedbackText: str | None = None
    reason: str | None = None


@router.post("/feedback")
async def feedback_endpoint(payload: FeedbackRequest) -> dict[str, Any]:
    if payload.rating not in _VALID_RATINGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="rating must be one of: " + ", ".join(sorted(_VALID_RATINGS)),
        )
    row = {
        "user_id":         payload.userId,
        "course_id":       payload.courseId,
        "question":        payload.question[:2000],
        "answer_cache_id": payload.answerCacheId,
        "rating":          payload.rating,
        "feedback_text":   (payload.feedbackText or "")[:1000] or None,
        "reason":          (payload.reason or "")[:200] or None,
    }
    sb = get_supabase()
    try:
        sb.table("ai_feedback").insert(row).execute()
    except Exception as e:  # noqa: BLE001
        log.exception("feedback insert failed")
        raise HTTPException(status_code=500, detail=f"Failed to save feedback: {e}")
    return {"ok": True}


# ── /evaluate-retrieval ──────────────────────────────────────────────────────


class EvaluateRequest(BaseModel):
    userId: str
    courseId: str
    evaluationId: str | None = None


def _judge(ev: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
    behavior = ev.get("expected_behavior") or "grounded"
    ans_text = (answer.get("answer") or "").lower()
    is_refused = (
        answer.get("retrievalMode") != "strong"
        or "could not find" in ans_text
        or "not in your uploaded" in ans_text
        or "nicht gefunden" in ans_text
    )
    if behavior == "refuse":
        return {"passed": is_refused, "failure_reason": None if is_refused else "Expected refusal but got a grounded answer."}
    if behavior == "general":
        ok = bool(answer.get("answer") and len(answer["answer"]) > 20)
        return {"passed": ok, "failure_reason": None if ok else "Answer was empty or too short."}
    # grounded (default)
    if is_refused:
        return {"passed": False, "failure_reason": "Answer was refused but a grounded answer was expected."}
    expected = ev.get("expected_sources") or []
    sources = answer.get("groundedSources") or []
    if expected:
        cited = [str(s.get("fileName") or "").lower() for s in sources]
        if not any(any(exp.lower() in c for c in cited) for exp in expected):
            return {
                "passed": False,
                "failure_reason": f"Expected sources not cited. Expected one of: {expected}. Got: {cited or 'none'}",
            }
    if not sources:
        return {"passed": False, "failure_reason": "No sources cited."}
    return {"passed": True, "failure_reason": None}


@router.post("/evaluate-retrieval")
async def evaluate_endpoint(payload: EvaluateRequest) -> dict[str, Any]:
    sb = get_supabase()
    q = sb.table("ai_evaluations").select(
        "id, test_question, expected_behavior, expected_sources"
    ).eq("course_id", payload.courseId)
    if payload.evaluationId:
        q = q.eq("id", payload.evaluationId)
    evaluations = (q.order("created_at").execute().data) or []
    if not evaluations:
        return {"ran": 0, "passed": 0, "failed": 0, "results": []}

    # Pull all course docs once so we can name them in retrieval.
    docs_resp = sb.table("documents").select("id, file_name").eq("user_id", payload.userId).eq("course_id", payload.courseId).execute()
    doc_names = {row["id"]: row["file_name"] for row in (docs_resp.data or [])}

    results: list[dict[str, Any]] = []
    for ev in evaluations:
        question = ev["test_question"]
        try:
            chunks = retrieve_chunks(
                user_id=payload.userId, course_id=payload.courseId,
                query=question, document_ids=None, top_k=12,
            )
            answer = generate_answer(question=question, chunks=chunks, doc_names=doc_names)
        except Exception as e:  # noqa: BLE001
            log.exception("eval question failed")
            answer = {"answer": "", "retrievalMode": "none", "groundedSources": []}
        verdict = _judge(ev, answer)
        try:
            sb.table("ai_evaluations").update({
                "actual_answer":     answer.get("answer", ""),
                "actual_sources":    answer.get("groundedSources") or [],
                "actual_confidence": "high" if answer.get("retrievalMode") == "strong" else "low",
                "passed":            verdict["passed"],
                "failure_reason":    verdict["failure_reason"],
                "run_at":            datetime.now(timezone.utc).isoformat(),
            }).eq("id", ev["id"]).execute()
        except Exception:
            log.exception("eval result store failed (non-fatal)")
        results.append({
            "id":                ev["id"],
            "test_question":     ev["test_question"],
            "expected_behavior": ev.get("expected_behavior"),
            "passed":            verdict["passed"],
            "failure_reason":    verdict["failure_reason"],
            "confidence":        "high" if answer.get("retrievalMode") == "strong" else "low",
            "sources_count":     len(answer.get("groundedSources") or []),
        })
    passed = sum(1 for r in results if r["passed"])
    return {"ran": len(results), "passed": passed, "failed": len(results) - passed, "results": results}

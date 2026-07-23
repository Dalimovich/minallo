"""Distributed, revision-scoped OCR for server-rendered PDF crops."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ..config import get_settings
from ..supabase_client import get_supabase
from .openai_client import get_openai_client
from .vision_ocr import _vision_extract

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class RegionOcrResult:
    text: str
    confidence: float
    status: str
    cache_hit: bool
    model: str


class RegionOcrError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _region_confidence(text: str) -> tuple[float, bool]:
    """Score a focused crop without penalizing it merely for being short."""
    normalized = text.strip()
    if not normalized:
        return 0.0, True
    unclear = len(re.findall(r"\[(?:unclear|illegible|uncertain)\]|\?{2,}", normalized, re.IGNORECASE))
    replacement_chars = normalized.count("\ufffd")
    useful_tokens = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿΑ-ωА-я]+|\d+(?:[.,]\d+)?|[=+\-×÷<>≤≥]", normalized)
    alnum = sum(char.isalnum() for char in normalized)
    visible = sum(not char.isspace() for char in normalized)
    legibility = alnum / max(1, visible)
    confidence = 0.96
    confidence -= min(0.45, unclear * 0.2 + replacement_chars * 0.15)
    if not useful_tokens:
        confidence -= 0.4
    if legibility < 0.35:
        confidence -= 0.25
    confidence = max(0.0, min(0.99, confidence))
    return confidence, unclear > 0 or replacement_chars > 0 or confidence < 0.75


def _cache_query(sb: Any, key: dict[str, Any]) -> Any:
    query = sb.table("pdf_region_ocr_results").select(
        "status, recognized_text, confidence, model, error_code"
    )
    for column, value in key.items():
        query = query.eq(column, value)
    return query.limit(1).execute()


def recognize_region(
    *,
    user_id: str,
    course_id: str,
    document_id: str,
    document_revision: str,
    index_revision: str,
    page_number: int,
    region_key: str,
    crop_sha256: str,
    crop_png: bytes,
    render_dpi: int = 220,
) -> RegionOcrResult:
    """Recognize one crop exactly once across workers and revisions."""
    settings = get_settings()
    if not settings.vision_ocr_enabled:
        raise RegionOcrError("region_ocr_disabled")
    model = settings.vision_ocr_model
    sb = get_supabase()
    params = {
        "p_user_id": user_id,
        "p_course_id": course_id,
        "p_document_id": document_id,
        "p_document_revision": document_revision,
        "p_index_revision": index_revision or "",
        "p_page_number": page_number,
        "p_region_key": region_key,
        "p_crop_sha256": crop_sha256,
        "p_render_dpi": render_dpi,
        "p_model": model,
    }
    claim = sb.rpc("claim_pdf_region_ocr", params).execute()
    claim_status = str(claim.data or "")
    key = {
        "user_id": user_id,
        "document_id": document_id,
        "document_revision": document_revision,
        "index_revision": index_revision or "",
        "page_number": page_number,
        "region_key": region_key,
        "render_dpi": render_dpi,
        "model": model,
    }
    if claim_status == "complete":
        rows = _cache_query(sb, key).data or []
        if rows and rows[0].get("recognized_text"):
            row = rows[0]
            return RegionOcrResult(
                text=str(row["recognized_text"]),
                confidence=float(row.get("confidence") or 0),
                status="complete",
                cache_hit=True,
                model=model,
            )
        raise RegionOcrError("region_ocr_cache_invalid")
    if claim_status == "weak":
        raise RegionOcrError("region_ocr_ambiguous")
    if claim_status == "processing":
        raise RegionOcrError("region_ocr_in_progress")
    if claim_status != "claimed":
        raise RegionOcrError("region_ocr_failed")

    month_start = datetime.now(UTC).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    ).isoformat()
    cap = max(1, int(settings.region_ocr_monthly_cap))
    completed = (
        sb.table("pdf_region_ocr_results")
        .select("region_key")
        .eq("user_id", user_id)
        .gte("completed_at", month_start)
        .in_("status", ["complete", "weak"])
        .limit(cap)
        .execute()
    ).data or []
    if len(completed) >= cap:
        sb.table("pdf_region_ocr_results").update({
            "status": "failed",
            "error_code": "budget_exhausted",
            "updated_at": datetime.now(UTC).isoformat(),
        }).match(key).execute()
        raise RegionOcrError("region_ocr_budget_exhausted")

    text = _vision_extract(
        get_openai_client(),
        model,
        crop_png,
        mode="standard",
    ).strip()
    if not text:
        sb.table("pdf_region_ocr_results").update({
            "status": "failed",
            "error_code": "empty_recognition",
            "updated_at": datetime.now(UTC).isoformat(),
        }).match(key).execute()
        raise RegionOcrError("region_ocr_failed")
    confidence, needs_review = _region_confidence(text)
    final_status = "weak" if needs_review or confidence < 0.75 else "complete"
    sb.table("pdf_region_ocr_results").update({
        "status": final_status,
        "recognized_text": text,
        "confidence": confidence,
        "completed_at": datetime.now(UTC).isoformat(),
        "updated_at": datetime.now(UTC).isoformat(),
    }).match(key).execute()
    if final_status != "complete":
        raise RegionOcrError("region_ocr_ambiguous")
    return RegionOcrResult(
        text=text,
        confidence=confidence,
        status=final_status,
        cache_hit=False,
        model=model,
    )


def store_region_comparison(
    *,
    user_id: str,
    document_id: str,
    document_revision: str,
    index_revision: str,
    page_number: int,
    region_key: str,
    render_dpi: int,
    model: str,
    critical_tokens: tuple[str, ...],
    disagreement: dict[str, Any],
) -> None:
    """Persist only structured comparison metadata, never private crop bytes."""
    key = {
        "user_id": user_id,
        "document_id": document_id,
        "document_revision": document_revision,
        "index_revision": index_revision or "",
        "page_number": page_number,
        "region_key": region_key,
        "render_dpi": render_dpi,
        "model": model,
    }
    get_supabase().table("pdf_region_ocr_results").update({
        "critical_tokens": list(critical_tokens),
        "disagreement": disagreement,
        "updated_at": datetime.now(UTC).isoformat(),
    }).match(key).execute()


__all__ = [
    "RegionOcrError",
    "RegionOcrResult",
    "recognize_region",
    "store_region_comparison",
]

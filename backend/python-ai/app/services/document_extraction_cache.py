"""Durable last-known-good cache for document structure and question inventory."""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from typing import Any

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

EXTRACTOR_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ExtractionCacheQuality:
    scope_complete: bool
    sections_found: int
    question_pages_processed: int
    question_pages_total: int
    questions_found: int
    out_of_scope_count: int
    failed_pages: list[int]


def canonical_extraction_target(target: str) -> str:
    value = (target or "questions").casefold()
    if "kurzfrag" in value or "short question" in value:
        return "kurzfragen"
    return " ".join(value.split())


def should_replace_cache(
    current: ExtractionCacheQuality | None,
    candidate: ExtractionCacheQuality,
) -> bool:
    if not candidate.scope_complete or candidate.question_pages_total <= 0:
        return False
    if candidate.questions_found <= 0 or candidate.out_of_scope_count:
        return False
    if current is None:
        return True
    if current.scope_complete and not candidate.scope_complete:
        return False
    if candidate.questions_found < current.questions_found:
        return False
    if candidate.sections_found < current.sections_found:
        return False
    return True


def load_verified_extraction_cache(
    *, user_id: str, document_id: str, document_revision: str,
    source_fingerprint: str, target: str,
) -> dict[str, Any] | None:
    canonical_target = canonical_extraction_target(target)
    try:
        response = (
            get_supabase().table("document_extraction_caches")
            .select("*")
            .eq("user_id", user_id)
            .eq("document_id", document_id)
            .eq("document_revision", document_revision)
            .eq("source_fingerprint", source_fingerprint)
            .eq("canonical_target", canonical_target)
            .eq("extractor_schema_version", EXTRACTOR_SCHEMA_VERSION)
            .eq("verified", True)
            .limit(1)
            .execute()
        )
    except Exception:
        log.exception(
            "scope_cache_load_failed document=%s revision=%s target=%s",
            document_id, document_revision, canonical_target,
        )
        return None
    rows = list(response.data or [])
    if not rows:
        log.info(
            "scope_cache_miss document=%s revision=%s target=%s",
            document_id, document_revision, canonical_target,
        )
        return None
    row = dict(rows[0])
    log.info(
        "scope_cache_hit document=%s revision=%s target=%s questions=%d",
        document_id, document_revision, canonical_target,
        len(row.get("questions") or []),
    )
    return row


def promote_verified_extraction_cache(
    *, user_id: str, document_id: str, document_revision: str,
    source_fingerprint: str, target: str, scope_fingerprint: str,
    scope: dict[str, Any], questions: list[dict[str, Any]],
    answer_evidence: list[dict[str, Any]], paired_items: list[dict[str, Any]],
    quality: ExtractionCacheQuality,
) -> bool:
    existing = load_verified_extraction_cache(
        user_id=user_id, document_id=document_id,
        document_revision=document_revision, source_fingerprint=source_fingerprint,
        target=target,
    )
    current_quality = None
    if existing and isinstance(existing.get("quality"), dict):
        try:
            current_quality = ExtractionCacheQuality(**existing["quality"])
        except (TypeError, ValueError):
            current_quality = None
    if not should_replace_cache(current_quality, quality):
        log.warning(
            "scope_candidate_rejected document=%s revision=%s previous_questions=%d "
            "candidate_questions=%d sections=%d out_of_scope=%d",
            document_id, document_revision,
            current_quality.questions_found if current_quality else 0,
            quality.questions_found, quality.sections_found, quality.out_of_scope_count,
        )
        return False
    payload = {
        "user_id": user_id,
        "document_id": document_id,
        "document_revision": document_revision,
        "source_fingerprint": source_fingerprint,
        "canonical_target": canonical_extraction_target(target),
        "extractor_schema_version": EXTRACTOR_SCHEMA_VERSION,
        "scope_fingerprint": scope_fingerprint,
        "scope": scope,
        "questions": questions,
        "answer_evidence": answer_evidence,
        "paired_items": paired_items,
        "quality": asdict(quality),
        "verified": True,
    }
    try:
        get_supabase().table("document_extraction_caches").upsert(
            payload,
            on_conflict=(
                "user_id,document_id,document_revision,source_fingerprint,"
                "canonical_target,extractor_schema_version"
            ),
        ).execute()
    except Exception:
        log.exception(
            "scope_cache_promote_failed document=%s revision=%s",
            document_id, document_revision,
        )
        return False
    log.info(
        "question_inventory_merged document=%s revision=%s questions=%d source=merged",
        document_id, document_revision, quality.questions_found,
    )
    return True

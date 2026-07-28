"""Canonical Deep Learn identity, existing-lesson reuse, and generation claims."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from ..supabase_client import get_supabase


def topic_fingerprint(topic: str) -> str:
    canonical = re.sub(r"[^a-z0-9äöüß]+", " ", (topic or "").lower()).strip()
    return hashlib.sha256(canonical.encode()).hexdigest()


def course_revision_hash(user_id: str, course_id: str, document_ids: list[str] | None) -> str:
    sb = get_supabase()
    query = sb.table("documents").select("id,document_hash").eq("user_id", user_id).eq("course_id", course_id)
    if document_ids:
        query = query.in_("id", list(dict.fromkeys(document_ids)))
    rows = query.execute().data or []
    values = sorted(f"{row.get('id')}:{row.get('document_hash') or ''}" for row in rows)
    return hashlib.sha256("|".join(values).encode()).hexdigest()


def launch_idempotency_key(
    *, user_id: str, course_id: str, topic: str, revision_hash: str,
    lesson_mode: str, lesson_language: str, recommendation_id: str | None,
) -> str:
    material = "|".join((
        user_id, course_id, topic_fingerprint(topic), revision_hash,
        lesson_mode, lesson_language, recommendation_id or "",
    ))
    return hashlib.sha256(material.encode()).hexdigest()


def find_existing_lesson(
    *, user_id: str, course_id: str, topic: str, revision_hash: str,
    max_age_days: int = 45,
) -> dict[str, Any] | None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
    rows = (
        get_supabase().table("notes")
        .select("id,title,content_markdown,lesson_status,updated_at,visual_ids")
        .eq("user_id", user_id).eq("course_id", course_id).eq("type", "deep_learn")
        .eq("topic_fingerprint", topic_fingerprint(topic))
        .eq("document_revision_hash", revision_hash).gte("updated_at", cutoff)
        .order("updated_at", desc=True).limit(1).execute()
    ).data or []
    return rows[0] if rows else None


@dataclass(frozen=True)
class GenerationClaim:
    status: str
    note_id: str | None = None


def claim_generation(
    *, user_id: str, course_id: str, idempotency_key: str,
    topic: str, revision_hash: str,
) -> GenerationClaim:
    sb = get_supabase()
    existing = (
        sb.table("deep_learn_generation_claims").select("status,note_id,claimed_at")
        .eq("user_id", user_id).eq("idempotency_key", idempotency_key).limit(1).execute()
    ).data or []
    if existing:
        return GenerationClaim(str(existing[0].get("status") or "processing"), existing[0].get("note_id"))
    try:
        sb.table("deep_learn_generation_claims").insert({
            "user_id": user_id, "idempotency_key": idempotency_key,
            "course_id": course_id, "topic_fingerprint": topic_fingerprint(topic),
            "document_revision_hash": revision_hash, "status": "processing",
        }).execute()
        return GenerationClaim("claimed")
    except Exception:
        rows = (
            sb.table("deep_learn_generation_claims").select("status,note_id")
            .eq("user_id", user_id).eq("idempotency_key", idempotency_key).limit(1).execute()
        ).data or []
        return GenerationClaim(str(rows[0].get("status") or "processing"), rows[0].get("note_id")) if rows else GenerationClaim("failed")


def finish_claim(*, user_id: str, idempotency_key: str, note_id: str | None, success: bool) -> None:
    get_supabase().table("deep_learn_generation_claims").update({
        "status": "complete" if success else "failed", "note_id": note_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("user_id", user_id).eq("idempotency_key", idempotency_key).execute()


__all__ = (
    "GenerationClaim", "claim_generation", "course_revision_hash", "find_existing_lesson",
    "finish_claim", "launch_idempotency_key", "topic_fingerprint",
)

"""ai_answer_cache helpers.

Caching is keyed by:
  user_id + course_id + question_hash + document_version_hash

`document_version_hash` is the sha256 of the sorted list of document_hashes
that participated in the answer — so when the user re-uploads a doc, the
hash changes and the answer is regenerated automatically.

`question_hash` now folds in every other input that can change the answer
text: tutor mode, the doc the student has open (deictic resolution),
and a short fingerprint of the visible-page text used as ``[Source 0]``.
Two students asking the same question on different pages of the same PDF
no longer collide.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)


def _normalize_question(q: str) -> str:
    """Trim + lowercase + collapse internal whitespace."""
    return " ".join((q or "").lower().split())


def question_hash(
    q: str,
    *,
    tutor_mode: str | None = None,
    active_document_id: str | None = None,
    visible_context: str | None = None,
    previous_turns: list[dict[str, str]] | None = None,
) -> str:
    """Composite cache key for an answer.

    Bundles every input that meaningfully changes the LLM output:
      * the question text (normalised)
      * tutor mode (explain vs solve vs quiz produce different prompts)
      * activeDocumentId — for deictic queries like "explain this", the
        same question string resolves to different content depending on
        which doc the student has open
      * a short fingerprint of the visible-page text (Source 0 input)
        so opening to page 4 vs page 9 of the same doc doesn't share a
        cached answer
      * a fingerprint of the recent chat history. Two students asking
        "explain that in simpler terms" in different chat sessions are
        referring to two completely different "thats" — without folding
        the history into the cache, one would get the other's answer.

    All extras default to None — legacy callers without context still
    produce a stable, smaller key.
    """
    parts = [_normalize_question(q)]
    if tutor_mode:
        parts.append(f"tm={tutor_mode}")
    if active_document_id:
        parts.append(f"ad={active_document_id}")
    if visible_context:
        # Hash truncated to 16 hex chars — enough to disambiguate distinct
        # page contents without bloating the key payload.
        vc_short = hashlib.sha256(
            visible_context.encode("utf-8")
        ).hexdigest()[:16]
        parts.append(f"vc={vc_short}")
    if previous_turns:
        # Stable serialise — join role+text per turn, hash the lot.
        # 16 hex chars is enough to disambiguate distinct conversations.
        serial = "\n".join(
            f"{(t.get('role') or '').lower()}:{(t.get('text') or '').strip()}"
            for t in previous_turns
        )
        if serial:
            pt_short = hashlib.sha256(serial.encode("utf-8")).hexdigest()[:16]
            parts.append(f"pt={pt_short}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


# Bump this when the answer pipeline changes (prompts, retrieval strength,
# citation logic, ...). All existing cache rows become unreachable, forcing
# regeneration on the next ask. Cheaper and safer than a manual DELETE.
#
# v4 widens the cache key — every existing v3 entry is now reachable only
# via the bare-question hash and the new composite key won't match, so
# old rows are effectively invalidated without a manual DELETE.
_CACHE_SCHEMA_VERSION = "v4-2026-05-21-composite-key"


def document_version_hash(document_hashes: list[str | None]) -> str:
    """sha256 over the sorted, non-null document_hash list, plus the
    pipeline schema version. Bumping the schema version invalidates every
    cached answer without touching the database."""
    cleaned = sorted(h for h in document_hashes if h)
    payload = _CACHE_SCHEMA_VERSION + "|" + "|".join(cleaned)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def fetch_document_version_hash(user_id: str, course_id: str, document_ids: list[str]) -> str:
    """Resolve document_ids → their document_hash values → version hash."""
    if not document_ids:
        return ""
    sb = get_supabase()
    try:
        resp = (
            sb.table("documents")
            .select("id, document_hash")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .in_("id", document_ids)
            .execute()
        )
    except Exception:
        log.exception("fetch document_hashes failed")
        return ""
    hashes = [row.get("document_hash") for row in (resp.data or [])]
    return document_version_hash(hashes)


def lookup_answer(
    *,
    user_id: str,
    course_id: str,
    question: str,
    version_hash: str,
    tutor_mode: str | None = None,
    active_document_id: str | None = None,
    visible_context: str | None = None,
    previous_turns: list[dict[str, str]] | None = None,
) -> dict[str, Any] | None:
    """Return the cached answer JSON, or None on miss. Bumps usage stats on hit.

    The extra kw-only params (``tutor_mode``, ``active_document_id``,
    ``visible_context``, ``previous_turns``) are folded into the composite
    ``question_hash`` so cache keys are sensitive to inputs that change
    the answer text but aren't part of the question string itself.
    Defaults are safe for legacy callers — they produce the bare-question
    key the v3 cache used.
    """
    if not version_hash:
        return None
    q_hash = question_hash(
        question,
        tutor_mode=tutor_mode,
        active_document_id=active_document_id,
        visible_context=visible_context,
        previous_turns=previous_turns,
    )
    sb = get_supabase()
    try:
        resp = (
            sb.table("ai_answer_cache")
            .select("id, answer_json")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .eq("question_hash", q_hash)
            .eq("document_version_hash", version_hash)
            .limit(1)
            .execute()
        )
    except Exception:
        log.exception("cache lookup failed")
        return None
    rows = resp.data or []
    if not rows:
        return None
    hit = rows[0]
    try:
        sb.table("ai_answer_cache").update({
            "last_used_at": datetime.now(timezone.utc).isoformat(),
            "usage_count":  (hit.get("usage_count") or 0) + 1,
        }).eq("id", hit["id"]).execute()
    except Exception:
        log.warning("cache usage bump failed (non-fatal)")
    return hit["answer_json"]


def save_answer(
    *,
    user_id: str,
    course_id: str,
    question: str,
    version_hash: str,
    answer_json: dict[str, Any],
    tutor_mode: str | None = None,
    active_document_id: str | None = None,
    visible_context: str | None = None,
    previous_turns: list[dict[str, str]] | None = None,
) -> None:
    """Upsert the answer for next time. Safe to no-op on errors.

    Must mirror ``lookup_answer``'s key-derivation — pass the same extras
    or the cache row won't be findable on the next query.
    """
    if not version_hash:
        return
    sb = get_supabase()
    payload = {
        "user_id":               user_id,
        "course_id":             course_id,
        "question_hash":         question_hash(
            question,
            tutor_mode=tutor_mode,
            active_document_id=active_document_id,
            visible_context=visible_context,
            previous_turns=previous_turns,
        ),
        "normalized_question":   _normalize_question(question),
        "document_version_hash": version_hash,
        "answer_json":           answer_json,
        "last_used_at":          datetime.now(timezone.utc).isoformat(),
    }
    try:
        sb.table("ai_answer_cache").upsert(
            payload,
            on_conflict="user_id,course_id,question_hash,document_version_hash",
        ).execute()
    except Exception:
        log.exception("cache save failed (non-fatal)")

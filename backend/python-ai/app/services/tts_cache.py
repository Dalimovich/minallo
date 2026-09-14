"""tts_audio_cache helpers — same shape as services/cache.py's
ai_answer_cache pattern, applied to generated Hören audio instead of AI
answers.

Cache key = sha256(modelVersion + voiceVersion + language + normalizedText).
Reordering questions or changing a quiz answer never touches this table —
only new spoken text does. Bump QWEN_TTS_MODEL_VERSION (config.py) to
invalidate everything at once if the model/voice changes, same way
_CACHE_SCHEMA_VERSION busts ai_answer_cache.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from ..config import get_settings
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)


def _normalize_text(text: str) -> str:
    return " ".join((text or "").strip().split())


def audio_cache_key(text: str, *, voice: str, language: str, model_version: str) -> str:
    parts = [model_version, voice, language, _normalize_text(text)]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def lookup_audio(text: str, *, voice: str, language: str) -> dict | None:
    """Returns {"storage_path", "duration_ms", "provider", "voice"} or None."""
    settings = get_settings()
    key = audio_cache_key(text, voice=voice, language=language, model_version=settings.qwen_tts_model_version)
    sb = get_supabase()
    try:
        resp = (
            sb.table("tts_audio_cache")
            .select("id, storage_path, duration_ms, provider, voice")
            .eq("text_hash", key)
            .limit(1)
            .execute()
        )
    except Exception:  # noqa: BLE001
        log.exception("tts cache lookup failed")
        return None
    rows = resp.data or []
    if not rows:
        return None
    hit = rows[0]
    try:
        sb.table("tts_audio_cache").update({
            "last_used_at": datetime.now(timezone.utc).isoformat(),
            "usage_count": (hit.get("usage_count") or 0) + 1,
        }).eq("id", hit["id"]).execute()
    except Exception:  # noqa: BLE001
        log.warning("tts cache usage bump failed (non-fatal)")
    return {
        "storage_path": hit["storage_path"],
        "duration_ms": hit.get("duration_ms"),
        "provider": hit.get("provider", "qwen3-tts"),
        "voice": hit.get("voice", voice),
    }


def save_audio(
    text: str,
    *,
    voice: str,
    language: str,
    storage_path: str,
    duration_ms: int | None,
    provider: str,
) -> None:
    settings = get_settings()
    key = audio_cache_key(text, voice=voice, language=language, model_version=settings.qwen_tts_model_version)
    sb = get_supabase()
    payload = {
        "text_hash": key,
        "provider": provider,
        "voice": voice,
        "language": language,
        "storage_path": storage_path,
        "duration_ms": duration_ms,
    }
    try:
        sb.table("tts_audio_cache").upsert(payload, on_conflict="text_hash").execute()
    except Exception:  # noqa: BLE001
        # Cache failures must never fail the request — the caller already
        # has usable audio bytes/URL regardless of whether this persists.
        log.exception("tts cache save failed (non-fatal)")

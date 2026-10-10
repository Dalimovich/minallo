"""POST /tts/generate[-batch] — internal endpoints behind the Cloudflare
Function proxy (backend/functions/ai-tts.ts, ai-tts-batch.ts). Never called
directly by the browser.

Flow per segment: cache lookup (services/tts_cache.py) -> on miss, Qwen3-TTS
via services/tts_provider.py -> upload to Storage -> cache the storage_path
-> return a signed URL. A cache hit skips generation entirely — the whole
point of content-addressing by text+voice+model version.

/tts/generate-batch exists specifically so a whole Hören lesson (8-12
segments) becomes ONE request from the browser instead of one per segment.
The frontend used to fire all segment requests in parallel itself, which let
a single browser session open 8-12 simultaneous generations against one
Qwen model instance — fine for cache hits, but a real problem for a cold
lesson on a small CPU box. This endpoint checks the cache for every segment
up front, then fans out ONLY the misses through a small server-side
ThreadPoolExecutor bounded by TTS_BATCH_MAX_CONCURRENCY (default 2),
regardless of how many segments the caller sent or how the frontend chooses
to call it — the client no longer controls Qwen concurrency at all.
qwen-tts's own QWEN_TTS_MAX_CONCURRENCY semaphore is the second, global
backstop behind this one (it caps concurrency across every caller, not just
one batch request).
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..config import get_settings
from ..services import storage, tts_cache
from ..services.tts_provider import TTSUnavailableError, get_tts_provider

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["tts"], dependencies=[Depends(require_internal_token)])

_ALLOWED_LANGUAGES = {"German"}
_MAX_TEXT_LENGTH = 2000
_MAX_BATCH_SEGMENTS = 30


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1)
    language: str = Field("German")
    voice: str | None = None


class TTSResponse(BaseModel):
    audioUrl: str
    durationMs: int
    provider: str
    voice: str
    cacheHit: bool = False


class TTSSegment(BaseModel):
    id: str = Field(..., min_length=1)
    text: str = Field(..., min_length=1)


class TTSBatchRequest(BaseModel):
    segments: list[TTSSegment] = Field(..., min_length=1)
    language: str = Field("German")
    voice: str | None = None


class TTSSegmentResult(BaseModel):
    id: str
    audioUrl: str | None = None
    durationMs: int = 0
    provider: str | None = None
    cacheHit: bool = False
    failed: bool = False


class TTSBatchResponse(BaseModel):
    segments: list[TTSSegmentResult]
    degraded: bool  # true if ANY segment failed — caller should fall back for the whole session


@dataclass
class _GeneratedAudio:
    audio_url: str
    duration_ms: int
    provider: str
    cache_hit: bool


def _validate_text(text: str, language: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text is required")
    if len(cleaned) > _MAX_TEXT_LENGTH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text is too long")
    if language not in _ALLOWED_LANGUAGES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unsupported language")
    return cleaned


def _generate_one(text: str, *, voice: str, language: str) -> _GeneratedAudio:
    """Cache-then-generate for one piece of text. Raises on hard failure —
    callers (both the single and batch endpoints) decide how to surface
    that (single: HTTP error; batch: mark that segment failed, keep going)."""
    settings = get_settings()

    cached = tts_cache.lookup_audio(text, voice=voice, language=language)
    if cached:
        try:
            url = storage.signed_audio_url(cached["storage_path"])
        except Exception:  # noqa: BLE001
            log.exception("failed to sign cached audio URL")
            url = None
        if url:
            return _GeneratedAudio(
                audio_url=url,
                duration_ms=cached.get("duration_ms") or 0,
                provider=cached.get("provider", "qwen3-tts"),
                cache_hit=True,
            )
        # Signing failed (e.g. object deleted out-of-band) — fall through and
        # regenerate rather than returning a dead cache row forever.

    provider = get_tts_provider()
    wav_bytes, duration_ms = provider.generate(text, language=language, voice=voice)

    key = tts_cache.audio_cache_key(
        text, voice=voice, language=language, model_version=settings.qwen_tts_model_version
    )
    storage_path = f"{key}.wav"
    stored_path = storage.upload_generated_audio(storage_path, wav_bytes)
    tts_cache.save_audio(
        text,
        voice=voice,
        language=language,
        storage_path=stored_path,
        duration_ms=duration_ms,
        provider=provider.provider_name(),
    )
    url = storage.signed_audio_url(stored_path)
    return _GeneratedAudio(
        audio_url=url, duration_ms=duration_ms, provider=provider.provider_name(), cache_hit=False
    )


@router.get("/tts/health")
def tts_health() -> dict[str, bool | str]:
    provider = get_tts_provider()
    ready = provider.health()
    return {"provider": provider.provider_name(), "ready": ready}


@router.post("/tts/generate", response_model=TTSResponse)
def tts_generate(payload: TTSRequest) -> TTSResponse:
    settings = get_settings()
    text = _validate_text(payload.text, payload.language)
    voice = payload.voice or settings.qwen_tts_voice

    try:
        result = _generate_one(text, voice=voice, language=payload.language)
    except TTSUnavailableError as exc:
        log.warning("tts unavailable, caller should fall back to browser TTS: %s", exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "TTS provider unavailable") from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("tts generation failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "TTS generation failed") from exc

    return TTSResponse(
        audioUrl=result.audio_url,
        durationMs=result.duration_ms,
        provider=result.provider,
        voice=voice,
        cacheHit=result.cache_hit,
    )


@router.post("/tts/generate-batch", response_model=TTSBatchResponse)
def tts_generate_batch(payload: TTSBatchRequest) -> TTSBatchResponse:
    settings = get_settings()
    if len(payload.segments) > _MAX_BATCH_SEGMENTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "too many segments")
    voice = payload.voice or settings.qwen_tts_voice
    language = payload.language

    # Validate everything up front — one bad segment shouldn't fan out N
    # generation calls before failing.
    texts_by_id: dict[str, str] = {}
    for seg in payload.segments:
        texts_by_id[seg.id] = _validate_text(seg.text, language)

    results: dict[str, TTSSegmentResult] = {}

    # Cache lookups are cheap Postgres reads — do them serially up front so
    # only genuine misses ever reach the bounded generation pool below.
    pending_ids: list[str] = []
    for seg_id, text in texts_by_id.items():
        cached = tts_cache.lookup_audio(text, voice=voice, language=language)
        if not cached:
            pending_ids.append(seg_id)
            continue
        try:
            url = storage.signed_audio_url(cached["storage_path"])
        except Exception:  # noqa: BLE001
            log.exception("failed to sign cached audio URL for segment %s", seg_id)
            url = None
        if url:
            results[seg_id] = TTSSegmentResult(
                id=seg_id,
                audioUrl=url,
                durationMs=cached.get("duration_ms") or 0,
                provider=cached.get("provider", "qwen3-tts"),
                cacheHit=True,
            )
        else:
            pending_ids.append(seg_id)

    def _work(seg_id: str) -> TTSSegmentResult:
        try:
            result = _generate_one(texts_by_id[seg_id], voice=voice, language=language)
        except Exception as exc:  # noqa: BLE001
            log.warning("batch tts generation failed for segment %s: %s", seg_id, exc)
            return TTSSegmentResult(id=seg_id, failed=True)
        return TTSSegmentResult(
            id=seg_id,
            audioUrl=result.audio_url,
            durationMs=result.duration_ms,
            provider=result.provider,
            cacheHit=result.cache_hit,
        )

    if pending_ids:
        # This is the actual concurrency control the frontend can no longer
        # bypass: however many segments were missing, at most
        # tts_batch_max_concurrency of them are ever in flight against Qwen
        # at once, the rest wait their turn in the executor's queue.
        with ThreadPoolExecutor(max_workers=max(1, settings.tts_batch_max_concurrency)) as pool:
            for res in pool.map(_work, pending_ids):
                results[res.id] = res

    ordered = [results[seg.id] for seg in payload.segments]
    degraded = any(r.failed for r in ordered)
    return TTSBatchResponse(segments=ordered, degraded=degraded)

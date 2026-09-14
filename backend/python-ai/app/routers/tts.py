"""POST /tts/generate — internal endpoint behind the Cloudflare Function
proxy (backend/functions/ai-tts.ts). Never called directly by the browser.

Flow: cache lookup (services/tts_cache.py) -> on miss, Qwen3-TTS via
services/tts_provider.py -> upload to Storage -> cache the storage_path ->
return a signed URL. A cache hit skips generation entirely — the whole
point of content-addressing by text+voice+model version.
"""

from __future__ import annotations

import logging

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


@router.get("/tts/health")
def tts_health() -> dict[str, bool | str]:
    provider = get_tts_provider()
    ready = provider.health()
    return {"provider": provider.provider_name(), "ready": ready}


@router.post("/tts/generate", response_model=TTSResponse)
def tts_generate(payload: TTSRequest) -> TTSResponse:
    settings = get_settings()
    text = payload.text.strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text is required")
    if len(text) > _MAX_TEXT_LENGTH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text is too long")
    if payload.language not in _ALLOWED_LANGUAGES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unsupported language")

    voice = payload.voice or settings.qwen_tts_voice

    cached = tts_cache.lookup_audio(text, voice=voice, language=payload.language)
    if cached:
        try:
            url = storage.signed_audio_url(cached["storage_path"])
        except Exception:  # noqa: BLE001
            log.exception("failed to sign cached audio URL")
            url = None
        if url:
            return TTSResponse(
                audioUrl=url,
                durationMs=cached.get("duration_ms") or 0,
                provider=cached.get("provider", "qwen3-tts"),
                voice=cached.get("voice", voice),
                cacheHit=True,
            )
        # Signing failed (e.g. object was deleted out-of-band) — fall through
        # and regenerate rather than returning a dead cache row forever.

    provider = get_tts_provider()
    try:
        wav_bytes, duration_ms = provider.generate(text, language=payload.language, voice=voice)
    except TTSUnavailableError as exc:
        log.warning("tts unavailable, caller should fall back to browser TTS: %s", exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "TTS provider unavailable") from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("tts generation failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "TTS generation failed") from exc

    key = tts_cache.audio_cache_key(
        text, voice=voice, language=payload.language, model_version=settings.qwen_tts_model_version
    )
    storage_path = f"{key}.wav"
    try:
        stored_path = storage.upload_generated_audio(storage_path, wav_bytes)
        tts_cache.save_audio(
            text,
            voice=voice,
            language=payload.language,
            storage_path=stored_path,
            duration_ms=duration_ms,
            provider=provider.provider_name(),
        )
        url = storage.signed_audio_url(stored_path)
    except Exception:  # noqa: BLE001
        log.exception("failed to store/sign generated audio")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Failed to store generated audio")

    return TTSResponse(
        audioUrl=url,
        durationMs=duration_ms,
        provider=provider.provider_name(),
        voice=voice,
        cacheHit=False,
    )

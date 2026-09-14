import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..config import get_settings
from ..engine import TTSGenerationError, get_engine

log = logging.getLogger("qwen-tts")

router = APIRouter(prefix="", tags=["tts"], dependencies=[Depends(require_internal_token)])

_ALLOWED_LANGUAGES = {"German"}


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1)
    language: str = Field("German")
    voice: str | None = None


class TTSResponse(BaseModel):
    audioBase64: str
    durationMs: int
    provider: str = "qwen3-tts"
    voice: str


@router.post("/tts/generate", response_model=TTSResponse)
def generate(payload: TTSRequest) -> TTSResponse:
    settings = get_settings()
    text = payload.text.strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text is required")
    if len(text) > settings.max_text_length:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "text is too long")
    if payload.language not in _ALLOWED_LANGUAGES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unsupported language")

    engine = get_engine()
    if not engine.is_ready():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "model not ready")

    try:
        wav_bytes, duration_ms = engine.generate(text, language=payload.language)
    except TTSGenerationError as exc:
        log.warning("tts generation refused: %s", exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "tts unavailable") from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("tts generation failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "tts generation failed") from exc

    import base64

    return TTSResponse(
        audioBase64=base64.b64encode(wav_bytes).decode("ascii"),
        durationMs=duration_ms,
        voice=payload.voice or settings.default_voice,
    )

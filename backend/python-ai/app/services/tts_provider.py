"""TTSProvider abstraction — the router (routers/tts.py) doesn't care which
concrete provider generated the audio, only whether one is available.

  TTSProvider
    generate(text, language, voice) -> (wav_bytes, duration_ms)
    health() -> bool
    provider_name() -> str

Only one real provider exists here: Qwen3-TTS, proxied to the isolated
backend/qwen-tts host. "Browser fallback" is not a server-side provider —
it's the frontend's own SpeechSynthesis path, used automatically whenever
this service reports unavailable (see frontend lsPlayer). That keeps this
service simple: it either returns real audio or a clean 503, never a fake
"fallback" audio asset.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)


class TTSUnavailableError(RuntimeError):
    pass


class TTSProvider(ABC):
    @abstractmethod
    def generate(self, text: str, *, language: str, voice: str) -> tuple[bytes, int]:
        """Returns (wav_bytes, duration_ms). Raises TTSUnavailableError."""

    @abstractmethod
    def health(self) -> bool: ...

    @abstractmethod
    def provider_name(self) -> str: ...


class QwenTTSProvider(TTSProvider):
    def provider_name(self) -> str:
        return "qwen3-tts"

    def _client_config(self) -> tuple[str, str, float] | None:
        settings = get_settings()
        if not settings.qwen_tts_service_url or not settings.qwen_tts_internal_secret:
            return None
        return settings.qwen_tts_service_url, settings.qwen_tts_internal_secret, settings.qwen_tts_timeout_s

    def health(self) -> bool:
        cfg = self._client_config()
        if not cfg:
            return False
        url, token, _timeout = cfg
        try:
            resp = httpx.get(
                url.rstrip("/") + "/health",
                timeout=httpx.Timeout(5.0, connect=3.0),
            )
            return resp.status_code == 200 and bool(resp.json().get("ready"))
        except Exception:  # noqa: BLE001
            return False

    def generate(self, text: str, *, language: str, voice: str) -> tuple[bytes, int]:
        cfg = self._client_config()
        if not cfg:
            raise TTSUnavailableError("Qwen TTS service not configured")
        url, token, timeout_s = cfg
        try:
            resp = httpx.post(
                url.rstrip("/") + "/tts/generate",
                json={"text": text, "language": language, "voice": voice},
                headers={"X-Internal-Token": token},
                timeout=httpx.Timeout(timeout_s, connect=10.0),
            )
        except httpx.TimeoutException as exc:
            raise TTSUnavailableError("Qwen TTS request timed out") from exc
        except httpx.HTTPError as exc:
            raise TTSUnavailableError("Qwen TTS request failed") from exc

        if resp.status_code != 200:
            raise TTSUnavailableError(f"Qwen TTS returned {resp.status_code}")

        import base64

        body = resp.json()
        wav_bytes = base64.b64decode(body["audioBase64"])
        duration_ms = int(body.get("durationMs") or 0)
        return wav_bytes, duration_ms


_provider: TTSProvider | None = None


def get_tts_provider() -> TTSProvider:
    global _provider
    if _provider is None:
        _provider = QwenTTSProvider()
    return _provider

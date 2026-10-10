"""Isolated Qwen3-TTS inference service.

Not reachable from public browser clients — see docs/CLAUDE.md and
backend/qwen-tts/deploy/README.md. python-ai is the only caller, via
QWEN_TTS_SERVICE_URL + the X-Internal-Token header (same shared-secret
pattern python-ai's own callers use).
"""

import logging
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from .config import get_settings
from .engine import get_engine
from .routers import tts as tts_router

settings = get_settings()
logging.basicConfig(level=settings.log_level)
log = logging.getLogger("qwen-tts")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    engine = get_engine()

    def _load() -> None:
        try:
            engine.load()
        except Exception:  # noqa: BLE001
            # Logged inside load(); swallow here so the process stays up and
            # /health can report "not ready" instead of crash-looping. An
            # operator (or the caller's fallback-to-browser-TTS path) sees a
            # clean 503, not a dead container.
            pass

    # Load in a background thread so the process can start accepting
    # connections (and answering /health as "loading") immediately, instead
    # of blocking container startup / the Docker HEALTHCHECK grace period on
    # a multi-minute model download+warm-up.
    threading.Thread(target=_load, name="qwen-tts-load", daemon=True).start()
    yield


app = FastAPI(
    title="Minallo Qwen TTS Service",
    version="0.1.0",
    description="Internal-only Qwen3-TTS voice-clone inference for Hören.",
    lifespan=_lifespan,
)

app.include_router(tts_router.router)


@app.get("/health")
async def health() -> dict[str, Any]:
    engine = get_engine()
    ready = engine.is_ready()
    return {
        "status": "ok" if ready else "loading",
        "service": "minallo-qwen-tts",
        "model": settings.model_id,
        "ready": ready,
        "error": engine.load_error() if not ready else None,
    }

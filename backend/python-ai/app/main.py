"""FastAPI entrypoint for the Minallo AI/RAG service.

Phase 1: only /health and a Supabase smoke test endpoint. No business
logic yet. Routers for /index-document, /ask, etc. are added in later
phases.
"""

import logging
import os
import threading
from contextlib import asynccontextmanager
from typing import Any

import anyio
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import require_internal_token
from .config import get_settings
from .routers import ask as ask_router
from .routers import chat as chat_router
from .routers import corrections as corrections_router
from .routers import email as email_router
from .routers import generate as generate_router
from .routers import index as index_router
from .routers import learning as learning_router
from .routers import misc as misc_router
from .routers import study_planner as study_planner_router
from .routers import notes_full as notes_full_router
from .routers import suggestions as suggestions_router
from .routers import stream as stream_router
from .routers import writing_coach as writing_coach_router
from .supabase_client import get_supabase

settings = get_settings()
logging.basicConfig(level=settings.log_level)
log = logging.getLogger("minallo-ai")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = 64

    def _recover() -> None:
        try:
            from .services.indexing import recover_orphaned_indexing

            recover_orphaned_indexing()
        except Exception:  # noqa: BLE001
            log.exception("startup indexing recovery failed")

    threading.Thread(
        target=_recover,
        name="indexing-recovery",
        daemon=True,
    ).start()
    yield


app = FastAPI(
    title="Minallo AI Service",
    version="0.6.0",
    description="PDF indexing, retrieval, and grounded answer generation.",
    lifespan=_lifespan,
)

# CORS — the streaming /ask-stream endpoint is called directly from the
# browser (bypasses the Pages Function proxy so the connection can stay open
# for SSE). Restrict to the production domain + Cloudflare Pages hosts.
# Localhost origins are added in non-production environments only — without
# them a dev frontend served from `localhost:8888` hitting prod
# `python-ai.fly.dev` gets a 400 on the CORS preflight (the user is not
# bypassing auth — JWT still verifies — they're just letting the browser pass
# the preflight).
_cors_origins = [
    "https://minallo.de",
    "https://www.minallo.de",
    "https://minallo.pages.dev",
]
if settings.environment != "production":
    _cors_origins += [
        "http://localhost:8888",
        "http://127.0.0.1:8888",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    # Cloudflare Pages preview deploys: https://<hash-or-branch>.minallo.pages.dev
    allow_origin_regex=r"^https://[a-z0-9-]+\.minallo\.pages\.dev$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Internal-Token", "Accept"],
)

app.include_router(index_router.router)
app.include_router(ask_router.router)
app.include_router(generate_router.router)
app.include_router(stream_router.router)
app.include_router(chat_router.router)
app.include_router(misc_router.router)
app.include_router(notes_full_router.router)
app.include_router(writing_coach_router.router)
app.include_router(corrections_router.router)
app.include_router(learning_router.router)
app.include_router(study_planner_router.router)
app.include_router(suggestions_router.router)
app.include_router(email_router.router)


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness probe. Unauthenticated on purpose — used by Fly/Netlify."""
    return {
        "status": "ok",
        "service": "minallo-ai",
        "version": app.version,
        "environment": settings.environment,
    }


@app.get("/internal/metrics", dependencies=[Depends(require_internal_token)])
async def metrics() -> dict[str, Any]:
    """Cheap runtime concurrency snapshot for tuning under load.

    No external Prometheus stack — just the numbers needed to see whether the
    anyio threadpool or the generation fan-out is the live bottleneck:
      - threadpool: total vs borrowed tokens (saturation = borrowed→total).
      - llmFanout: how many generation LLM slots are held vs the cap.
    Per gunicorn worker, so scrape/observe both PIDs over a load test.
    """
    from .services.concurrency import fanout_stats

    limiter = anyio.to_thread.current_default_thread_limiter()
    return {
        "pid": os.getpid(),
        "threadpool": {
            "total": limiter.total_tokens,
            "borrowed": limiter.borrowed_tokens,
        },
        "llmFanout": fanout_stats(),
    }


@app.get("/internal/db-smoke", dependencies=[Depends(require_internal_token)])
def db_smoke() -> dict[str, Any]:
    """Tiny read against `documents` to confirm Supabase wiring works.

    Returns the count only — no row data. Used during deploy to verify
    the service can reach Postgres with the service-role key.
    """
    sb = get_supabase()
    try:
        # head=True asks Postgres for the count without shipping rows.
        result = sb.table("documents").select("id", count="exact", head=True).execute()
        return {"ok": True, "documents_count": result.count}
    except Exception as e:  # noqa: BLE001 — surface to caller for diagnostics
        log.exception("db smoke failed")
        return {"ok": False, "error": str(e)}

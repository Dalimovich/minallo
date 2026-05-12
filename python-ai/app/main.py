"""FastAPI entrypoint for the StudySphere AI/RAG service.

Phase 1: only /health and a Supabase smoke test endpoint. No business
logic yet. Routers for /index-document, /ask, etc. are added in later
phases.
"""

import logging
from typing import Any

from fastapi import Depends, FastAPI

from .auth import require_internal_token
from .config import get_settings
from .supabase_client import get_supabase

settings = get_settings()
logging.basicConfig(level=settings.log_level)
log = logging.getLogger("studysphere-ai")

app = FastAPI(
    title="StudySphere AI Service",
    version="0.1.0",
    description="PDF indexing, retrieval, and grounded answer generation.",
)


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness probe. Unauthenticated on purpose — used by Fly/Netlify."""
    return {
        "status": "ok",
        "service": "studysphere-ai",
        "version": app.version,
        "environment": settings.environment,
    }


@app.get("/internal/db-smoke", dependencies=[Depends(require_internal_token)])
async def db_smoke() -> dict[str, Any]:
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

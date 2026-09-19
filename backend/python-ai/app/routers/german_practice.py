"""POST /german-practice/generate — general Wortschatz/Grammatik practice.

Internal-token gated; the Cloudflare function verifies the Supabase JWT and
forwards the trusted userId. Not tied to any exam profile.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.german_practice import MAX_LEVEL_LEN, MODULES, PracticeError, SourceNotReadyError, generate_practice

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["german_practice"], dependencies=[Depends(require_internal_token)])


class GeneratePracticeRequest(BaseModel):
    userId: str
    module: str
    level: str
    topic: str = Field(max_length=200)
    count: int = 10
    sourceDocumentIds: list[str] | None = Field(default=None, max_length=5)
    avoidPrompts: list[str] | None = Field(default=None, max_length=40)
    weakAreas: list[str] | None = Field(default=None, max_length=8)


@router.post("/german-practice/generate")
def generate_practice_endpoint(payload: GeneratePracticeRequest) -> dict[str, Any]:
    if payload.module not in MODULES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid module")
    if not payload.level.strip() or len(payload.level) > MAX_LEVEL_LEN:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid level")
    try:
        return generate_practice(
            user_id=payload.userId, module=payload.module, level=payload.level,
            topic=payload.topic.strip() or "general", count=payload.count,
            source_document_ids=payload.sourceDocumentIds,
            avoid_prompts=[a[:300] for a in (payload.avoidPrompts or [])],
            weak_areas=[w[:80] for w in (payload.weakAreas or [])],
        )
    except SourceNotReadyError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except PracticeError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("german-practice generation failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Generation failed") from exc

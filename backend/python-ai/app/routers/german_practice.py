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
from ..services import gen_timing
from ..services.german_learner_profile import get_german_learner_profile
from ..services.german_practice import MAX_LEVEL_LEN, MODULES, PracticeError, SourceNotReadyError, generate_practice

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["german_practice"], dependencies=[Depends(require_internal_token)])


class GeneratePracticeRequest(BaseModel):
    userId: str
    module: str
    # Ignored: the level always comes from the authenticated profile. Kept
    # optional only so older clients that still send it don't fail validation.
    level: str | None = None
    # Explicit, session-only practice override (e.g. the learner deliberately
    # picked an easier level). Never rewrites the profile.
    sessionLevelOverride: str | None = None
    topic: str = Field(max_length=200)
    count: int = 10
    sourceDocumentIds: list[str] | None = Field(default=None, max_length=5)
    avoidPrompts: list[str] | None = Field(default=None, max_length=40)
    weakAreas: list[str] | None = Field(default=None, max_length=8)


@router.post("/german-practice/generate")
def generate_practice_endpoint(payload: GeneratePracticeRequest):
    if payload.module not in MODULES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid module")
    override = (payload.sessionLevelOverride or "").strip()
    if len(override) > MAX_LEVEL_LEN:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid level")
    with gen_timing.timed_request(payload.module, budget_s=45) as timer:
        with gen_timing.stage("profileMs"):
            profile = get_german_learner_profile(payload.userId)
        if profile is None:
            gen_timing.finish(timer, "profile_unavailable")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Your profile could not be loaded right now. Please try again.",
            )
        if profile.has_target:
            level = override or profile.target_level
        elif override:
            level = override
        else:
            gen_timing.finish(timer, "no_target_level")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Choose your German target level in Profile first.",
            )
        try:
            result = generate_practice(
                user_id=payload.userId, module=payload.module, level=level,
                topic=payload.topic.strip() or "general", count=payload.count,
                source_document_ids=payload.sourceDocumentIds,
                avoid_prompts=[a[:300] for a in (payload.avoidPrompts or [])],
                weak_areas=[w[:80] for w in (payload.weakAreas or [])],
            )
        except SourceNotReadyError as exc:
            gen_timing.finish(timer, "source_not_ready")
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
        except PracticeError as exc:
            return gen_timing.failure_response(timer, "invalid_output", status.HTTP_502_BAD_GATEWAY, str(exc))
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, gen_timing.GenerationBudgetExceeded) or timer.expired():
                return gen_timing.failure_response(
                    timer, "budget_exceeded", status.HTTP_504_GATEWAY_TIMEOUT, "Generation took too long")
            log.exception("german-practice generation failed request_id=%s", timer.request_id)
            return gen_timing.failure_response(timer, "error", status.HTTP_502_BAD_GATEWAY, "Generation failed")
        result["diagnostics"] = gen_timing.finish(timer, "ok")
        return result

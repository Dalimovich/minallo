"""POST /chat — generic GPT-4o chatbot with vision (replaces ai.js)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..auth import require_internal_token
from ..services.chat import ChatValidationError, run_chat

log = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["chat"], dependencies=[Depends(require_internal_token)])


class ChatRequest(BaseModel):
    userId: str | None = None
    system: str | None = None
    messages: list[dict[str, Any]]
    max_tokens: int | None = None
    model: str | None = None  # accepted for backwards compat; ignored (we always use gpt-4o)


@router.post("/chat")
def chat_endpoint(payload: ChatRequest) -> dict[str, Any]:
    try:
        return run_chat(payload.model_dump(exclude_none=True))
    except ChatValidationError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:  # noqa: BLE001
        log.exception("chat failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Internal error")

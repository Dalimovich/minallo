"""Internal suggestion validation endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..auth import require_internal_token
from ..services.suggestion_validation import validate_suggestion

router = APIRouter(
    prefix="/suggestions",
    tags=["suggestions"],
    dependencies=[Depends(require_internal_token)],
)


class SuggestionValidationRequest(BaseModel):
    userId: str
    kind: str
    parent: str = "*"
    value: str = Field(..., min_length=1, max_length=120)
    context: dict[str, Any] = Field(default_factory=dict)


@router.post("/validate")
def validate_endpoint(payload: SuggestionValidationRequest) -> dict[str, Any]:
    return validate_suggestion(
        kind=payload.kind,
        parent=payload.parent,
        value=payload.value,
        context=payload.context,
    )

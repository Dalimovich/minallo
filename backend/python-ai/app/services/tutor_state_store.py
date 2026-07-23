"""Shared, tenant-scoped persistence for production tutoring state."""

from __future__ import annotations

import logging
from typing import Any

from ..supabase_client import get_supabase
from .tutor_state import TutorState

log = logging.getLogger(__name__)


def claim_generation(
    user_id: str, conversation_id: str, course_id: str, generation: int,
) -> bool:
    response = get_supabase().rpc(
        "claim_ai_tutor_generation",
        {
            "p_user_id": user_id,
            "p_conversation_id": conversation_id,
            "p_course_id": course_id,
            "p_generation": generation,
        },
    ).execute()
    return bool(response.data)


def load_tutor_state(user_id: str, conversation_id: str) -> TutorState:
    """Load one user's conversation state; never accept a cross-user row."""
    response = (
        get_supabase().table("ai_tutor_states")
        .select("state")
        .eq("user_id", user_id)
        .eq("conversation_id", conversation_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    raw: dict[str, Any] = rows[0].get("state") or {} if rows else {}
    state = TutorState.from_api(raw, conversation_id=conversation_id)
    state.user_id = user_id
    return state


def save_tutor_state(user_id: str, course_id: str, state: TutorState) -> None:
    """Upsert state under the authenticated user and conversation identity."""
    state.user_id = user_id
    state.course_id = course_id
    response = get_supabase().rpc(
        "save_ai_tutor_state",
        {
            "p_user_id": user_id,
            "p_course_id": course_id,
            "p_conversation_id": state.conversation_id,
            "p_generation": state.generation,
            "p_state": state.to_api(),
        },
    ).execute()
    if not response.data:
        raise RuntimeError("stale tutoring state write rejected")


def current_persisted_generation(user_id: str, conversation_id: str) -> int | None:
    response = (
        get_supabase().table("ai_tutor_states")
        .select("generation")
        .eq("user_id", user_id)
        .eq("conversation_id", conversation_id)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return int(rows[0]["generation"]) if rows else None


__all__ = [
    "claim_generation", "current_persisted_generation",
    "load_tutor_state", "save_tutor_state",
]

"""Durable, idempotent chat identity and message persistence."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from ..supabase_client import get_supabase


@dataclass(frozen=True)
class DurableConversation:
    conversation_id: str
    created: bool


def ensure_durable_conversation(
    *,
    user_id: str,
    client_conversation_id: str,
    course_id: str | None,
    active_document_id: str | None,
    title_seed: str | None,
    client_message_id: str | None = None,
    message_text: str | None = None,
) -> DurableConversation:
    """Resolve one browser chat to one server conversation and save its turn."""
    client_key = client_conversation_id.strip()
    if not client_key or len(client_key) > 160:
        raise ValueError("invalid client conversation id")
    sb = get_supabase()
    existing = (
        sb.table("ai_chat_conversations")
        .select("id")
        .eq("user_id", user_id)
        .eq("client_conversation_id", client_key)
        .limit(1)
        .execute()
    ).data or []
    created = not bool(existing)
    conversation_id = str(existing[0]["id"]) if existing else str(uuid.uuid4())
    if created:
        try:
            sb.table("ai_chat_conversations").insert({
                "id": conversation_id,
                "user_id": user_id,
                "client_conversation_id": client_key,
                "course_id": course_id or None,
                "active_document_id": active_document_id or None,
                "title": (title_seed or "").strip()[:180] or None,
            }).execute()
        except Exception:
            # A double Enter/retry can win the unique-key race in another
            # request. Resolve the winning row instead of creating a duplicate.
            rows = (
                sb.table("ai_chat_conversations")
                .select("id")
                .eq("user_id", user_id)
                .eq("client_conversation_id", client_key)
                .limit(1)
                .execute()
            ).data or []
            if not rows:
                raise
            conversation_id = str(rows[0]["id"])
            created = False

    if client_message_id and (message_text or "").strip():
        sb.table("ai_chat_messages").upsert({
            "conversation_id": conversation_id,
            "user_id": user_id,
            "client_message_id": client_message_id[:160],
            "role": "user",
            "content": (message_text or "").strip(),
        }, on_conflict="conversation_id,client_message_id").execute()
    return DurableConversation(conversation_id=conversation_id, created=created)


def validate_durable_conversation(*, user_id: str, conversation_id: str) -> bool:
    rows = (
        get_supabase().table("ai_chat_conversations")
        .select("id")
        .eq("id", conversation_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    ).data or []
    return bool(rows)


__all__ = ["DurableConversation", "ensure_durable_conversation", "validate_durable_conversation"]

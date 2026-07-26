"""Durable, idempotent chat identity and message persistence."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any
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


def create_durable_tutor_turn(
    *, user_id: str, conversation_id: str, user_message_id: str,
    user_content: str, assistant_message_id: str, request_id: str,
    request_snapshot: dict[str, Any],
) -> None:
    """Atomically persist the user turn, assistant placeholder and request."""
    get_supabase().rpc("create_ai_tutor_turn", {
        "p_conversation_id": conversation_id,
        "p_user_id": user_id,
        "p_user_message_id": user_message_id[:160],
        "p_user_content": user_content,
        "p_assistant_message_id": assistant_message_id[:160],
        "p_request_id": request_id[:128],
        "p_request_snapshot": request_snapshot,
    }).execute()


def update_tutor_request(
    *, user_id: str, request_id: str, status: str, stage: str,
    partial_answer: str | None = None, final_answer: str | None = None,
    error_code: str | None = None, retryable: bool = True,
    automatic_retry_count: int | None = None,
) -> None:
    patch: dict[str, Any] = {
        "status": status, "stage": stage, "error_code": error_code,
        "retryable": retryable, "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if partial_answer is not None:
        patch["partial_answer"] = partial_answer
    if final_answer is not None:
        patch["final_answer"] = final_answer
    if automatic_retry_count is not None:
        patch["automatic_retry_count"] = automatic_retry_count
    sb = get_supabase()
    rows = (
        sb.table("ai_tutor_requests")
        .select("conversation_id,assistant_client_message_id,partial_answer,final_answer")
        .eq("request_id", request_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    if not rows:
        raise RuntimeError("tutor_request_not_found")
    if final_answer is not None and rows[0].get("partial_answer"):
        saved_partial = str(rows[0]["partial_answer"]).strip()
        if saved_partial and not final_answer.startswith(saved_partial):
            final_answer = saved_partial + "\n\n" + final_answer
            patch["final_answer"] = final_answer
    (sb.table("ai_tutor_requests").update(patch)
     .eq("request_id", request_id).eq("user_id", user_id).execute())
    assistant_id = str(rows[0].get("assistant_client_message_id") or "")
    conversation_id = str(rows[0].get("conversation_id") or "")
    if assistant_id and conversation_id:
        message_patch: dict[str, Any] = {
            "completion_state": {
                "queued": "pending", "running": "processing", "recovering": "recovering",
                "completed": "complete", "interrupted": "interrupted", "failed": "failed_recoverable",
            }.get(status, status),
            "error_code": error_code, "failure_stage": stage, "retryable": retryable,
        }
        content = final_answer if final_answer is not None else partial_answer
        if content is not None:
            message_patch["content"] = content
        (sb.table("ai_chat_messages").update(message_patch)
         .eq("conversation_id", conversation_id)
         .eq("client_message_id", assistant_id).execute())


def get_tutor_request(*, user_id: str, request_id: str) -> dict[str, Any] | None:
    rows = (
        get_supabase().table("ai_tutor_requests")
        .select("request_id,conversation_id,user_client_message_id,assistant_client_message_id,status,stage,partial_answer,final_answer,error_code,retryable,request_snapshot,last_event_id,automatic_retry_count,fallback_used,updated_at")
        .eq("request_id", request_id).eq("user_id", user_id).limit(1).execute()
    ).data or []
    return dict(rows[0]) if rows else None


__all__ = [
    "DurableConversation", "ensure_durable_conversation", "validate_durable_conversation",
    "create_durable_tutor_turn", "update_tutor_request", "get_tutor_request",
]

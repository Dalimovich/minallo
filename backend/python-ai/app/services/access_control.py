"""Subscription gate + per-user rate limiting for endpoints the browser hits
directly (currently /ask-stream).

The Netlify functions enforce both checks in TS land via
backend/lib/subscription-gate.ts and backend/lib/rate-limit.ts. /ask-stream
bypasses Netlify so we re-implement the same checks here against the same
Supabase tables, so a paid user gets the same access shape regardless of
whether they hit /api/ai/ask (Netlify) or /ask-stream (Fly).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_ACTIVE_STATUSES = {"active", "trialing"}


def _log_security_event(user_id: str, event_type: str, metadata: dict | None = None) -> None:
    row: dict[str, Any] = {"user_id": user_id, "event_type": event_type}
    if metadata:
        row["metadata"] = metadata
    try:
        get_supabase().table("security_events").insert(row).execute()
    except Exception:  # noqa: BLE001
        log.exception("failed to log security event %s", event_type)

# Two independent buckets, mirroring backend/lib/rate-limit.ts. Interactive
# (chat / RAG / writing-coach / stream asks) is cheap per call and gets a
# large allowance; generation (notes / quiz / flashcards) is heavier per
# call and gets a tighter one.
_INTERACTIVE_EVENT_TYPES = (
    "ai_ask",
    "ai_chat",
    "writing_coach_analyse",
    "ask_stream",
)
_GENERATION_EVENT_TYPES = (
    "ai_generate",
    "notes_generate",
)


def require_active_subscription(user_id: str, reason: str) -> None:
    """Raise 402 if the user is not on an active or trialing subscription."""
    sb = get_supabase()
    try:
        resp = (
            sb.table("subscriptions")
            .select("status, expires_at")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
    except Exception:  # noqa: BLE001
        log.exception("subscription lookup failed for %s", user_id)
        # Fail closed — if we can't verify, deny. Avoids open-by-default
        # behavior on transient DB blips.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Subscription verification temporarily unavailable",
        )

    row = (resp.data or [None])[0]
    status_value = (row or {}).get("status") if isinstance(row, dict) else None
    expires_at_raw = (row or {}).get("expires_at") if isinstance(row, dict) else None
    expires_at = _parse_iso(expires_at_raw)
    now = datetime.now(timezone.utc)
    ok = status_value in _ACTIVE_STATUSES and expires_at is not None and expires_at > now

    if not ok:
        # Log to the same security_events table the Netlify gate uses so we
        # have one feed of subscription_gate_blocked events.
        _log_security_event(user_id, "subscription_gate_blocked", {"reason": reason, "status": status_value or "none"})
        raise HTTPException(
            status_code=402,
            detail="Active subscription required.",
        )


def enforce_rate_limit(
    user_id: str,
    event_type: str,
    max_events: int,
    window_seconds: int,
    message: str = "AI request limit reached. Please try again later.",
) -> None:
    """Count recent security_events of the given type and raise 429 if exceeded.

    Uses the same `security_events` table the Netlify rate limiter uses, so
    both paths share one rolling window.
    """
    sb = get_supabase()
    since = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()
    try:
        resp = (
            sb.table("security_events")
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("event_type", event_type)
            .gte("created_at", since)
            .execute()
        )
    except Exception:  # noqa: BLE001
        log.exception("rate-limit lookup failed for %s/%s", user_id, event_type)
        # Fail open on lookup error — we'd rather serve a paid user than 503
        # them on a transient blip. The Netlify path makes the same trade-off
        # implicitly (any failure throws and we'd want graceful degradation).
        return

    count = resp.count or len(resp.data or [])
    if count >= max_events:
        _log_security_event(user_id, event_type + "_rate_limited", {"count": count, "window_seconds": window_seconds})
        raise HTTPException(
            status_code=429,
            detail=message,
            headers={"Retry-After": str(window_seconds)},
        )

    _log_security_event(user_id, event_type)


def _enforce_bucket_cap(
    user_id: str,
    bucket: str,
    event_types: tuple[str, ...],
    max_events: int,
) -> None:
    sb = get_supabase()
    now = datetime.now(timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    try:
        resp = (
            sb.table("security_events")
            .select("id", count="exact")
            .eq("user_id", user_id)
            .in_("event_type", list(event_types))
            .gte("created_at", start.isoformat())
            .execute()
        )
    except Exception:  # noqa: BLE001
        log.exception("monthly-cap lookup failed for %s/%s", user_id, bucket)
        # Fail open on transient DB issues — same trade-off as enforce_rate_limit.
        return

    count = resp.count or len(resp.data or [])
    if count < max_events:
        return

    _log_security_event(user_id, "ai_monthly_cap_blocked", {"bucket": bucket, "count": count, "cap": max_events})

    if now.month == 12:
        next_reset = now.replace(year=now.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        next_reset = now.replace(month=now.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)
    retry_after = max(60, int((next_reset - now).total_seconds()))

    if bucket == "interactive":
        friendly = (
            f"You've reached this month's chat + tutor allowance ({max_events} AI calls). "
            "Resets on the 1st of next month."
        )
    else:
        friendly = (
            f"You've reached this month's quiz / flashcard / notes generation allowance "
            f"({max_events} bulk operations). Chat and tutor still work. "
            "Resets on the 1st of next month."
        )

    raise HTTPException(
        status_code=429,
        detail={
            "code": "ai_monthly_cap",
            "bucket": bucket,
            "message": friendly,
            "used": count,
            "limit": max_events,
            "resetsAt": next_reset.isoformat(),
        },
        headers={"Retry-After": str(retry_after)},
    )


def enforce_interactive_cap(user_id: str, max_events: int) -> None:
    """Interactive bucket cap (chat / RAG / writing-coach / streaming asks)."""
    _enforce_bucket_cap(user_id, "interactive", _INTERACTIVE_EVENT_TYPES, max_events)


def enforce_generation_cap(user_id: str, max_events: int) -> None:
    """Generation bucket cap (quiz / flashcards / notes summaries)."""
    _enforce_bucket_cap(user_id, "generation", _GENERATION_EVENT_TYPES, max_events)


def enforce_monthly_ai_cap(user_id: str, max_events: int) -> None:
    """Deprecated wrapper — routes to the interactive bucket.

    Existing callers passed the single combined cap; the interactive bucket
    is the right home for chat / ask-stream traffic.
    """
    enforce_interactive_cap(user_id, max_events)


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    # Supabase returns timestamptz as ISO 8601; Python 3.11 handles the Z form.
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

"""Verify Supabase user JWTs.

Used by the streaming /ask endpoint, which the browser calls directly
(no Netlify hop) so the connection stays open for SSE. The token comes
in as `Authorization: Bearer <jwt>` and is verified against Supabase's
auth API the same way backend/lib/supabase-auth.js does it.
"""

from __future__ import annotations

import logging
import base64
import json
import time
from typing import Any

import httpx
from fastapi import Header, HTTPException, status

from .config import get_settings

log = logging.getLogger(__name__)


def _auth_error(code: str, message: str, retryable: bool) -> dict[str, Any]:
    return {"code": code, "message": message, "retryable": retryable}


def _is_expired(token: str) -> bool:
    """Classify an already-rejected JWT without trusting it for authentication."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return float(data.get("exp", 0)) <= time.time()
    except (ValueError, TypeError, IndexError, json.JSONDecodeError):
        return False


async def verify_supabase_jwt(authorization: str = Header(default="")) -> dict[str, Any]:
    """Return the verified Supabase user dict (id, email, …) or raise 401."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_auth_error("SESSION_INVALID", "Please sign in to continue.", False),
        )
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_auth_error("SESSION_INVALID", "Please sign in to continue.", False),
        )

    settings = get_settings()
    url = settings.supabase_url.rstrip("/") + "/auth/v1/user"
    # The "apikey" header is required by Supabase Auth even on this endpoint —
    # service-role works fine and is already in our env.
    headers = {
        "Authorization": f"Bearer {token}",
        "apikey": settings.supabase_service_role_key,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url, headers=headers)
    except httpx.HTTPError as e:
        log.warning("supabase auth verify network error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_auth_error(
                "AUTH_SERVICE_UNAVAILABLE",
                "Authentication is temporarily unavailable. Please retry.",
                True,
            ),
        )
    if r.status_code != 200:
        code = "ACCESS_TOKEN_EXPIRED" if _is_expired(token) else "SESSION_INVALID"
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_auth_error(code, "Your session could not be verified.", code == "ACCESS_TOKEN_EXPIRED"),
        )
    try:
        user = r.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=_auth_error("AUTH_SERVICE_ERROR", "Authentication returned an invalid response.", True),
        )
    if not user or not user.get("id"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_auth_error("SESSION_INVALID", "Your session could not be verified.", False),
        )
    return user

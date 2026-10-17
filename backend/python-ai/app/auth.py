"""Shared-secret auth between the Netlify proxy and this service.

The browser never talks to this service directly. The Netlify function
`ai-proxy.js` verifies the user's Supabase JWT, derives the trusted
`user_id`, then forwards the request with the internal token header.
"""

import hmac

from fastapi import Header, HTTPException, status

from .config import get_settings


async def require_internal_token(x_internal_token: str = Header(default="")) -> None:
    settings = get_settings()
    accepted = [t for t in (settings.ai_service_internal_token, settings.ai_service_internal_token_previous) if t]
    # compare_digest on every candidate (no early exit on the first match/miss)
    matches = [hmac.compare_digest(x_internal_token, t) for t in accepted]
    if not accepted or not any(matches):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal token",
        )

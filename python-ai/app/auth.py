"""Shared-secret auth between the Netlify proxy and this service.

The browser never talks to this service directly. The Netlify function
`ai-proxy.js` verifies the user's Supabase JWT, derives the trusted
`user_id`, then forwards the request with the internal token header.
"""

from fastapi import Header, HTTPException, status

from .config import get_settings


async def require_internal_token(x_internal_token: str = Header(default="")) -> None:
    expected = get_settings().ai_service_internal_token
    if not expected or x_internal_token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal token",
        )

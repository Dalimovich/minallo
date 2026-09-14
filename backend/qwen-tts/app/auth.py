"""Shared-secret auth between python-ai and this service.

Mirrors backend/python-ai/app/auth.py exactly. This service is never
reachable from the public internet with a browser-facing route — only
python-ai calls it, over its own private network / firewall rule, with this
header as a second layer of defense.
"""

import hmac

from fastapi import Header, HTTPException, status

from .config import get_settings


async def require_internal_token(x_internal_token: str = Header(default="")) -> None:
    expected = get_settings().internal_token
    if not expected or not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal token",
        )

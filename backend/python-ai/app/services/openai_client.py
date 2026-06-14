"""Shared, connection-pooled OpenAI client.

Every call site used to do ``OpenAI(api_key=...)`` inline, which builds a
*fresh* httpx connection pool each time — so every embedding batch, answer
stream, quiz/cheatsheet shard and vision-OCR call paid a new TCP+TLS handshake
to api.openai.com and held its threadpool thread for that extra time. Under
concurrency that handshake churn is pure blocking-I/O waste and tightens the
anyio threadpool ceiling.

The OpenAI SDK (and the httpx client underneath) is safe to share across
threads, so a single process-wide instance lets keep-alive connections be
reused across requests. ``lru_cache`` makes it lazy and per-process, which is
exactly right under gunicorn (each worker gets its own pool).
"""

from functools import lru_cache

import httpx
from openai import OpenAI

from ..config import get_settings


@lru_cache(maxsize=1)
def get_openai_client() -> OpenAI:
    """Process-wide pooled OpenAI client. Reused across threads/requests."""
    settings = get_settings()
    return OpenAI(
        api_key=settings.openai_api_key,
        # Keep the SDK default retry behaviour explicit.
        max_retries=2,
        http_client=httpx.Client(
            # Retain plenty of keep-alive connections so a burst of concurrent
            # LLM calls reuses warm sockets instead of re-handshaking. Sized to
            # comfortably cover the per-worker anyio threadpool (64).
            limits=httpx.Limits(
                max_connections=100,
                max_keepalive_connections=100,
                keepalive_expiry=30.0,
            ),
            # Match the SDK's generous default read budget (streaming answers
            # and reasoning models can pause between tokens) while failing fast
            # on connect/pool acquisition.
            timeout=httpx.Timeout(600.0, connect=10.0, pool=10.0),
        ),
    )

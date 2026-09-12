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
            # Generous default read budget for background/batch callers (quiz,
            # cheatsheet, flashcards, indexing, …) that have no live user
            # waiting on a response. The interactive /ask-stream path overrides
            # this per-call with INTERACTIVE_ANSWER_TIMEOUT /
            # INTERACTIVE_SUPPORT_TIMEOUT below — see their docstrings for why.
            timeout=httpx.Timeout(600.0, connect=10.0, pool=10.0),
        ),
    )


# Per-call timeout override for the interactive /ask-stream answer-generation
# call (the model actually writing the answer the user is watching stream in).
# httpx's read timeout is measured PER READ, not for the whole call, so a
# model that keeps sending chunks — including a long "thinking" pause before
# the first token from a reasoning model — is never cut off by this; only a
# true stall (zero bytes) for this long trips it. 120s is chosen specifically
# to sit above the frontend's own 90s stream-idle-failure threshold
# (STREAM_IDLE_FAILURE_MS in shell.ts) so a genuinely slow-but-working answer
# is never killed before the client would have given up on it anyway, while
# still cutting the worst-case silent hang from the shared client's 600s down
# to near what the user experiences as "stuck" — the request now reaches its
# own error handling (and reports a real, retryable failure) in ~2 minutes
# instead of ~10.
INTERACTIVE_ANSWER_TIMEOUT = httpx.Timeout(120.0, connect=10.0, pool=10.0)

# Per-call timeout override for small, synchronous support calls that sit in
# the interactive /ask-stream request path before any token can reach the
# client at all (language-rewrite pass, query embedding). These have no
# reasoning-model "long pause" to accommodate, so a much tighter budget both
# fails fast on a genuine provider stall and still comfortably covers normal
# latency for a short, non-streaming completion.
INTERACTIVE_SUPPORT_TIMEOUT = httpx.Timeout(45.0, connect=10.0, pool=10.0)

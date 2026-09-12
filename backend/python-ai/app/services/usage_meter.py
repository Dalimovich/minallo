"""Fire-and-forget OpenAI usage metering → ``usage_events`` table.

Answers "what does one user / one feature cost per month". Every OpenAI call
site reports its token counts here; events are queued in-process and written
by a daemon thread in small batches so the hot path never waits on a DB
insert. Failures are logged and dropped — metering must never block or break
an answer.

Costs are intentionally NOT stored: they are derived at query time from the
token counts, so a pricing change never requires a backfill.

``user_id`` is optional. Request-scoped paths (/ask-stream, /ask) attribute
to the student; service-level calls with no request context (indexing,
embeddings, JSON generation helpers) land unattributed but still count
toward per-feature totals.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any

from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_QUEUE_MAX = 1000
_BATCH_MAX = 25
# After the first event of a batch, wait this long for stragglers so bursts
# (e.g. cheatsheet shards) coalesce into one insert.
_COALESCE_SECONDS = 0.25

_queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=_QUEUE_MAX)
_worker_started = False
_worker_lock = threading.Lock()


def record_usage(
    *,
    feature: str,
    model: str | None,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    cached_tokens: int | None = 0,
    user_id: str | None = None,
) -> None:
    """Enqueue one usage event. Never raises; zero-token events are skipped."""
    try:
        if not (prompt_tokens or completion_tokens):
            return
        event: dict[str, Any] = {
            "user_id": user_id or None,
            "feature": (feature or "unknown")[:60],
            "model": (model or "unknown")[:80],
            "prompt_tokens": int(prompt_tokens or 0),
            "completion_tokens": int(completion_tokens or 0),
            "cached_tokens": int(cached_tokens or 0),
        }
        _ensure_worker()
        _queue.put_nowait(event)
    except queue.Full:
        log.warning("usage meter queue full — dropping event")
    except Exception:
        log.exception("usage meter enqueue failed")


def usage_from_response(resp: Any) -> dict[str, int]:
    """Token counts from a non-streaming OpenAI response (chat or embeddings).

    Shape-tolerant: missing ``usage`` (or missing cached-token details, which
    embeddings responses don't have) degrades to zeros instead of raising.
    """
    u = getattr(resp, "usage", None)
    details = getattr(u, "prompt_tokens_details", None) if u else None
    return {
        "prompt_tokens": int(getattr(u, "prompt_tokens", 0) or 0),
        "completion_tokens": int(getattr(u, "completion_tokens", 0) or 0),
        "cached_tokens": int(getattr(details, "cached_tokens", 0) or 0),
    }


def _ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    with _worker_lock:
        if _worker_started:
            return
        threading.Thread(target=_worker, name="usage-meter", daemon=True).start()
        _worker_started = True


def _worker() -> None:
    while True:
        batch = [_queue.get()]
        deadline = time.time() + _COALESCE_SECONDS
        while len(batch) < _BATCH_MAX:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            try:
                batch.append(_queue.get(timeout=remaining))
            except queue.Empty:
                break
        try:
            get_supabase().table("usage_events").insert(batch).execute()
        except Exception:
            log.exception("usage meter insert failed — %d event(s) dropped", len(batch))


__all__ = ("record_usage", "usage_from_response")

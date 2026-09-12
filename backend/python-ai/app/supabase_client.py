"""Supabase service-role client. Never exposed to the browser."""

import os
from functools import lru_cache

from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

from .config import get_settings

# Every request hits PostgREST several times (auth, rate-limit, usage,
# retrieval, cache). The supabase-py default leaves the HTTP call without an
# explicit timeout, so a slow/hung PostgREST response can pin an anyio
# threadpool thread indefinitely — a quiet way to exhaust concurrency under
# load. Cap it: a PostgREST CRUD call that takes longer than this is failing,
# and failing fast frees the thread. Tunable via env.
_DEFAULT_CLIENT_TIMEOUT = 30


def _client_timeout() -> int:
    try:
        return max(1, int(os.environ.get("SUPABASE_CLIENT_TIMEOUT", "")))
    except ValueError:
        return _DEFAULT_CLIENT_TIMEOUT


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    """Singleton service-role client. Bypasses RLS — only used server-side."""
    settings = get_settings()
    timeout = _client_timeout()
    # SyncClientOptions (not the base ClientOptions) carries the storage /
    # httpx_client attributes the sync client's auth init reads.
    options = SyncClientOptions(
        postgrest_client_timeout=timeout,
        storage_client_timeout=timeout,
    )
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key, options
    )

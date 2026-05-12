"""Supabase service-role client. Never exposed to the browser."""

from functools import lru_cache

from supabase import Client, create_client

from .config import get_settings


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    """Singleton service-role client. Bypasses RLS — only used server-side."""
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_service_role_key)

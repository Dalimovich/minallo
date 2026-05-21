"""Session-wide test setup.

The real ``app.config`` uses pydantic-settings and reads its values from env
vars. Setting these here at MODULE top — not in a fixture — guarantees they
are present before any test module is imported, so test files can safely do
``from app.config import get_settings`` at their own module top without
needing to stub ``app.config`` themselves.

This also fixes a cross-test leak: previously some tests replaced
``sys.modules['app.config']`` with a fake module whose ``get_settings`` was a
plain ``lambda``. That fake leaked into the rest of the session, so any later
test calling ``get_settings.cache_clear()`` (on the assumption it was an
``@lru_cache`` function) failed with ``AttributeError``. The fix is to make
the real module loadable, so no test needs to overwrite it.
"""

from __future__ import annotations

import os

# Stubs only — production values are read from the real env in deploy.
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub-service-role-key")
os.environ.setdefault("OPENAI_API_KEY", "stub-openai-key")
os.environ.setdefault("INTERNAL_SECRET", "stub-internal-token")

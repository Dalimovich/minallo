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

# Eagerly register the real service modules that some test files used to stub
# with bare ``types.ModuleType`` placeholders (via
# ``sys.modules.setdefault("app.services.embeddings", fake)``). Those fakes
# omitted public symbols like ``EmbeddingServiceUnavailable`` and, because
# ``setdefault`` leaves whatever is registered first in place, they leaked into
# the whole session — breaking any later test that imported the real symbol
# (e.g. the ask/stream/generate routers). The deps those stubs were guarding
# against (``openai``, ``supabase``) are installed in CI/dev now, so importing
# the real modules first turns every such ``setdefault`` into a harmless no-op.
# Import is side-effect-free: the OpenAI client is only built at call time.
import app.services.embeddings  # noqa: E402,F401
import app.supabase_client  # noqa: E402,F401

"""Unit tests for notes generation (notes.py)."""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import notes  # noqa: E402


def test_system_prompt_requires_strict_math_formatting_everywhere():
    # Regression coverage: this rule used to be the bare one-liner "4. Math
    # in KaTeX." with no elaboration, no prohibition on bare Unicode Greek
    # letters, and no example — which is exactly the shape the model failed
    # to follow in production (formulas like "deltaS = 2.4 x 10^-6" showing
    # up with no $ delimiters at all). Must now match the same strict,
    # example-driven rule already proven in flashcards.py/deep_learn.py.
    sys = notes._system_prompt("medium-length")
    assert "Math formatting is STRICT" in sys
    assert "not just Formula/Theorem" in sys  # applies to every section, not just formula cards
    assert "NEVER write a bare LaTeX command" in sys
    assert "NOT raw Unicode glyphs" in sys
    assert "$\\delta_S = 2.4 \\times 10^{-6}$" in sys
    assert "δS = 2.4 x 10^-6" in sys  # the exact bad-example shape, spelled out

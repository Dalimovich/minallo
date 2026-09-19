"""Per-model OpenAI prices for request-level cost diagnostics.

MIRRORS ``MODEL_PRICES_CENTS_PER_M`` in ``backend/lib/admin-stats.ts`` (the
admin dashboard's canonical table, which prices ``usage_events`` at read time).
``tests/test_model_pricing.py`` parses that file and fails if the two drift, so
there is one set of numbers. Cents per 1M tokens; prefix-matched, most specific
first. Unknown models are reported as unpriced instead of silently 0.
"""

from __future__ import annotations

import os

# (prefix, input, cached, output) - cents per 1M tokens.
MODEL_PRICES_CENTS_PER_M: tuple[tuple[str, float, float, float], ...] = (
    ("gpt-5.4-mini", 75, 7.5, 450),
    ("gpt-4o-mini", 15, 7.5, 60),
    ("gpt-4o", 250, 125, 1000),
    ("gpt-4.1-mini", 40, 10, 160),
    ("gpt-4.1-nano", 10, 2.5, 40),
    ("gpt-4.1", 200, 50, 800),
    ("o4-mini", 110, 27.5, 440),
    ("o3-mini", 110, 55, 440),
    ("text-embedding-3-small", 2, 2, 0),
    ("text-embedding-3-large", 13, 13, 0),
)


def _regional_uplift(model: str | None) -> float:
    """Multiplier for regional data-residency processing (OpenAI lists +10% for
    some models). Whether Minallo uses such an endpoint is a deployment fact, so
    it is explicit config, default OFF — never inferred from server location.
        OPENAI_REGIONAL_UPLIFT_PCT=10
        OPENAI_REGIONAL_UPLIFT_MODELS=gpt-5.4   (comma-separated prefixes; default gpt-5.4)
    """
    try:
        pct = float(os.getenv("OPENAI_REGIONAL_UPLIFT_PCT", "0") or 0)
    except ValueError:
        return 1.0
    if pct <= 0:
        return 1.0
    prefixes = [p.strip().lower() for p in os.getenv("OPENAI_REGIONAL_UPLIFT_MODELS", "gpt-5.4").split(",") if p.strip()]
    m = (model or "").lower()
    return 1.0 + pct / 100.0 if any(m.startswith(p) for p in prefixes) else 1.0


def price_for(model: str | None) -> tuple[float, float, float] | None:
    m = (model or "").lower()
    for prefix, inp, cached, out in MODEL_PRICES_CENTS_PER_M:
        if m.startswith(prefix):
            return inp, cached, out
    return None


def estimate_cost_usd(model: str | None, prompt_tokens: int, cached_tokens: int, completion_tokens: int) -> float | None:
    """USD for one call; ``None`` when the model has no price entry.

    Cached tokens are part of prompt_tokens but billed at the cached rate;
    reasoning tokens are part of completion_tokens (already billed as output).
    """
    p = price_for(model)
    if p is None:
        return None
    inp, cached_rate, out = p
    prompt = max(0, int(prompt_tokens or 0))
    cached = min(max(0, int(cached_tokens or 0)), prompt)
    completion = max(0, int(completion_tokens or 0))
    cents = ((prompt - cached) * inp + cached * cached_rate + completion * out) / 1_000_000
    return cents * _regional_uplift(model) / 100

"""Request-level cost diagnostics use the SAME prices as the admin dashboard."""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

from app.services import gen_timing
from app.services.model_pricing import MODEL_PRICES_CENTS_PER_M, estimate_cost_usd, price_for
from app.services.usage_meter import reasoning_tokens_from_response


def test_python_table_matches_admin_stats_ts():
    ts = (Path(__file__).resolve().parents[3] / "backend/lib/admin-stats.ts").read_bytes().decode("utf-8", "ignore")
    rows = re.findall(
        r"prefix:\s*'([^']+)',\s*price:\s*\{\s*input:\s*([\d.]+),\s*cached:\s*([\d.]+),\s*output:\s*([\d.]+)\s*\}", ts)
    parsed = tuple((p, float(i), float(c), float(o)) for p, i, c, o in rows)
    assert parsed == tuple((p, float(i), float(c), float(o)) for p, i, c, o in MODEL_PRICES_CENTS_PER_M)


def test_gpt_5_4_mini_has_an_explicit_price():
    assert price_for("gpt-5.4-mini") == (75, 7.5, 450)
    assert price_for("gpt-5.4-mini-2026-03-01") == (75, 7.5, 450)
    # $0.75 / $0.075 cached / $4.50 per 1M: 1M prompt (250k cached) + 100k output
    cost = estimate_cost_usd("gpt-5.4-mini", 1_000_000, 250_000, 100_000)
    assert abs(cost - (750_000 * 0.75 + 250_000 * 0.075 + 100_000 * 4.5) / 1_000_000) < 1e-9


def test_mini_does_not_fall_into_gpt_4o_or_unknown_pricing():
    assert price_for("gpt-4o-mini") == (15, 7.5, 60)
    assert price_for("gpt-4o-2024-08-06") == (250, 125, 1000)
    assert price_for("some-new-model") is None
    assert estimate_cost_usd("some-new-model", 10, 0, 10) is None


def test_reasoning_tokens_are_read_when_exposed_and_zero_otherwise():
    resp = SimpleNamespace(usage=SimpleNamespace(completion_tokens_details=SimpleNamespace(reasoning_tokens=321)))
    assert reasoning_tokens_from_response(resp) == 321
    assert reasoning_tokens_from_response(SimpleNamespace(usage=None)) == 0
    assert reasoning_tokens_from_response(SimpleNamespace(usage=SimpleNamespace())) == 0


def test_timer_summary_carries_tokens_cost_and_by_caller_without_content():
    t = gen_timing.GenTimer("reading", "lesen_1")
    t.record_call(caller="german_exam_reading", model="gpt-5.4-mini", effort="medium", slot_wait_ms=5,
                  provider_ms=1200, ok=True, prompt_tokens=10_000, cached_tokens=2_000,
                  completion_tokens=3_000, reasoning_tokens=1_500)
    t.record_call(caller="german_exam_semantic_verify", model="gpt-5.4-mini", effort="medium", slot_wait_ms=0,
                  provider_ms=800, ok=True, prompt_tokens=4_000, cached_tokens=0, completion_tokens=500,
                  reasoning_tokens=200)
    t.record_call(caller="german_exam_semantic_verify", model="gpt-5.4-mini", effort="medium", slot_wait_ms=0,
                  provider_ms=50, ok=False)
    s = t.summary("ok")
    assert s["promptTokens"] == 14_000 and s["cachedTokens"] == 2_000
    assert s["completionTokens"] == 3_500 and s["reasoningTokens"] == 1_700
    expected = (8_000 * 75 + 2_000 * 7.5 + 3_000 * 450) / 1e8 + (4_000 * 75 + 500 * 450) / 1e8
    assert abs(s["estimatedCostUsd"] - expected) < 1e-6
    assert s["unpricedModels"] == []
    v = s["byCaller"]["german_exam_semantic_verify"]
    assert v["calls"] == 2 and v["promptTokens"] == 4_000 and v["reasoningTokens"] == 200
    assert set(s["calls"][0]) == {"caller", "model", "effort", "providerMs", "slotWaitMs", "ok", "promptTokens",
                                  "cachedTokens", "completionTokens", "reasoningTokens", "estimatedCostUsd"}
    assert "prompt" not in str(s).lower().replace("prompttokens", "")


def test_unknown_model_is_reported_unpriced_not_free():
    t = gen_timing.GenTimer("x")
    t.record_call(caller="c", model="brand-new", effort=None, slot_wait_ms=0, provider_ms=1, ok=True,
                  prompt_tokens=100, completion_tokens=100)
    assert t.summary("ok")["unpricedModels"] == ["brand-new"]

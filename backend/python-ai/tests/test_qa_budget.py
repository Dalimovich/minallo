"""scripts/qa_budget.py: bounded-cost QA harness support. Pure bookkeeping —
no provider calls, no network — so these are plain unit tests."""
import argparse
import sys
from pathlib import Path

import pytest

# pytest prepends this tests/ dir onto sys.path ahead of backend/python-ai
# itself, so a bare `import scripts` would otherwise resolve to the unrelated
# tests/scripts/ package (eval_retrieval.py) instead of backend/python-ai/scripts/.
# Real invocation (`python -m scripts.qa_budget` from backend/python-ai) is
# unaffected by this; only pytest's own path ordering needs the nudge.
_BACKEND_ROOT = str(Path(__file__).resolve().parents[1])
if _BACKEND_ROOT in sys.path:
    sys.path.remove(_BACKEND_ROOT)
sys.path.insert(0, _BACKEND_ROOT)
# pytest's own collection may already have cached `scripts` -> tests/scripts/
# in sys.modules before this file's top-level code runs; drop that cache too,
# or the reordered sys.path above has nothing left to do.
for _name in [n for n in sys.modules if n == "scripts" or n.startswith("scripts.")]:
    del sys.modules[_name]

from scripts.qa_budget import SAFE_MAX_COST_USD, SAFE_MAX_SAMPLES, BudgetExceeded, QaBudget, add_budget_args, labeled_usage  # noqa: E402


def test_refuses_zero_or_missing_cost_or_sample_bounds():
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=0, max_samples=1, label="x")
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=0.1, max_samples=0, label="x")
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=None, max_samples=1, label="x")
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=0.1, max_samples=None, label="x")


def test_refuses_bounds_above_the_safe_defaults():
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=SAFE_MAX_COST_USD + 0.01, max_samples=1, label="x")
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=0.1, max_samples=SAFE_MAX_SAMPLES + 1, label="x")


def test_refuses_negative_cost():
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=-0.1, max_samples=1, label="x")


def test_requires_a_usage_label():
    with pytest.raises(ValueError):
        QaBudget(max_cost_usd=0.1, max_samples=1, label="")


def test_accepts_the_safe_default_bounds_exactly():
    budget = QaBudget(max_cost_usd=SAFE_MAX_COST_USD, max_samples=SAFE_MAX_SAMPLES, label="testdaf_lesen_qa")
    budget.guard_new_sample()  # must not raise: nothing spent yet


def test_guard_new_sample_stops_before_exceeding_the_sample_cap():
    budget = QaBudget(max_cost_usd=0.25, max_samples=1, label="x")
    budget.guard_new_sample()
    budget.record_sample()
    with pytest.raises(BudgetExceeded):
        budget.guard_new_sample()


def test_guard_new_sample_stops_before_the_next_call_once_cost_is_spent_not_only_after():
    """The check happens on the NEXT guard_new_sample() call, before any further provider
    call would be made — cost is never only reported after the fact."""
    budget = QaBudget(max_cost_usd=0.10, max_samples=1, label="x")
    budget.guard_new_sample()
    budget.record_call(0.10, sample=1)
    with pytest.raises(BudgetExceeded):
        budget.guard_new_sample()


def test_record_call_treats_an_unpriced_call_as_zero_cost_not_a_free_pass():
    budget = QaBudget(max_cost_usd=0.10, max_samples=1, label="x")
    budget.record_call(None, sample=1)
    assert budget.spent_usd == 0.0
    assert budget.calls[0]["costUsd"] is None


def test_add_budget_args_are_required_with_no_default():
    parser = argparse.ArgumentParser()
    add_budget_args(parser)
    with pytest.raises(SystemExit):
        parser.parse_args([])  # missing --max-cost-usd/--max-samples must fail, not default to unbounded
    args = parser.parse_args(["--max-cost-usd", "0.25", "--max-samples", "1"])
    assert args.max_cost_usd == 0.25 and args.max_samples == 1


def test_labeled_usage_overrides_the_feature_label_and_restores_the_previous_hook_after(monkeypatch):
    from app.services import llm_json

    captured = []
    stub = lambda **kw: captured.append(kw)  # noqa: E731
    monkeypatch.setattr(llm_json, "record_usage", stub)
    with labeled_usage("testdaf_hoeren_qa"):
        llm_json.record_usage(feature="german_exam_listening", model="gpt-x", prompt_tokens=10, completion_tokens=5)
    assert llm_json.record_usage is stub  # restored to whatever was installed before the context, not a fixed original
    assert captured == [{"feature": "testdaf_hoeren_qa", "model": "gpt-x", "prompt_tokens": 10, "completion_tokens": 5}]


def test_labeled_usage_restores_the_original_record_usage_on_exit_and_on_exception():
    from app.services import llm_json

    original = llm_json.record_usage
    with labeled_usage("testdaf_schreiben_qa"):
        assert llm_json.record_usage is not original
    assert llm_json.record_usage is original

    with pytest.raises(RuntimeError):
        with labeled_usage("testdaf_sprechen_qa"):
            raise RuntimeError("boom")
    assert llm_json.record_usage is original

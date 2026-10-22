"""Phase 3 — math evaluation fixture runner.

These tests are deterministic guards on the fixture itself:

- the JSON loads and every case has the required fields,
- every case's `expectedDetector` matches the live Phase 6 detector,
- the category coverage doesn't accidentally shrink.

End-to-end answer quality eval is intentionally NOT here. That needs
real Supabase + OpenAI credit and a course-team review pass. See
tests/fixtures/README.md for how to plug in real course data.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "math_eval_cases.json"

_ALLOWED_CATEGORIES = {
    "exact_exercise_reference",
    "formula_lookup",
    "solve_with_values",
    "derivation",
    "proof",
    "definition",
    "non_math",
    "off_topic",
}


def _import_retrieval():
    """Stub missing native deps, then import retrieval fresh."""
    fake_sb = types.ModuleType("app.supabase_client")
    fake_sb.get_supabase = lambda: None
    sys.modules.setdefault("app.supabase_client", fake_sb)
    fake_emb = types.ModuleType("app.services.embeddings")
    fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
    sys.modules.setdefault("app.services.embeddings", fake_emb)
    if "app.services.retrieval" in sys.modules:
        del sys.modules["app.services.retrieval"]
    from app.services import retrieval  # noqa: WPS433
    return retrieval


def _load_cases():
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    return data["cases"]


_CASES = _load_cases()


# ── Schema validation ───────────────────────────────────────────────────────


def test_fixture_loads_and_has_min_cases() -> None:
    assert len(_CASES) >= 10, "plan-v2 calls for 10-20 cases; don't fall below 10"


def test_fixture_ids_are_unique() -> None:
    ids = [c["id"] for c in _CASES]
    assert len(ids) == len(set(ids)), "duplicate case ids in fixture"


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_case_has_required_fields(case: dict) -> None:
    for field in ("id", "question", "category", "expectedBehavior"):
        assert field in case, f"case {case.get('id')!r} missing {field!r}"
    assert case["category"] in _ALLOWED_CATEGORIES, (
        f"case {case['id']!r} has unknown category {case['category']!r}"
    )


def test_category_coverage_intact() -> None:
    covered = {c["category"] for c in _CASES}
    missing = _ALLOWED_CATEGORIES - covered
    assert not missing, f"fixture lost coverage for: {sorted(missing)}"


# ── Detector behavior (Phase 6 contract) ────────────────────────────────────


@pytest.mark.parametrize(
    "case",
    [c for c in _CASES if "expectedDetector" in c],
    ids=lambda c: c["id"],
)
def test_detector_matches_expected(case: dict) -> None:
    r = _import_retrieval()
    got = r.find_exercise_reference(case["question"])
    expected = case["expectedDetector"]

    if expected is None:
        assert got is None, (
            f"{case['id']}: expected NO detector match for "
            f"{case['question']!r}, got {got!r}"
        )
        return

    assert got is not None, (
        f"{case['id']}: expected detector match {expected!r} for "
        f"{case['question']!r}, got None"
    )
    exercise_number, subpart = got
    assert exercise_number == expected["exerciseNumber"], case["id"]
    # Normalize subpart comparison (detector returns None or lowercase letter).
    assert (subpart or None) == (expected.get("subpart") or None), case["id"]

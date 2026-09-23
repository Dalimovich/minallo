import pytest

from app.services.german_exams.result import (
    build_module_result,
    official_style_scaled_result,
    practice_formative_result,
    practice_raw_result,
)
from app.services.german_exams.shared import GermanExamProfileError, ScoringSpec

TELC_READING_SCORING = ScoringSpec(max_points=8, points_per_correct=1)
TELC_LISTENING_LOOKUP = ScoringSpec(
    max_points=100, mode="lookup_table", pass_points=60,
    raw_item_count=2, raw_to_result_points=(0, 50, 100),
)


def test_practice_raw_result_is_plain_correctness():
    result = practice_raw_result(5, 7)
    assert result == {"kind": "practice_raw_result", "correct": 5, "total": 7, "percent": round(500 / 7, 1)}


def test_practice_raw_result_rejects_impossible_counts():
    with pytest.raises(GermanExamProfileError):
        practice_raw_result(8, 7)
    with pytest.raises(GermanExamProfileError):
        practice_raw_result(-1, 7)


def test_practice_raw_result_zero_total_has_no_percent():
    assert practice_raw_result(0, 0)["percent"] is None


def test_official_scaled_result_is_none_without_a_verified_scoring_spec():
    """This is the TestDaF case today: every TestDaF part has scoring=None (no published
    raw->scaled conversion), so this must return None rather than inventing a score."""
    assert official_style_scaled_result(None, 5) is None


def test_official_scaled_result_uses_fixed_per_item():
    result = official_style_scaled_result(TELC_READING_SCORING, 6)
    assert result == {"kind": "official_style_scaled_result", "points": 6, "maxPoints": 8}
    assert "pass" not in result  # no verified pass mark on this spec


def test_official_scaled_result_uses_lookup_table_and_reports_pass():
    result = official_style_scaled_result(TELC_LISTENING_LOOKUP, 1)
    assert result == {"kind": "official_style_scaled_result", "points": 50, "maxPoints": 100, "pass": False}
    passing = official_style_scaled_result(TELC_LISTENING_LOOKUP, 2)
    assert passing["pass"] is True


def test_official_scaled_result_never_fabricates_tdn_or_pass_fields():
    result = official_style_scaled_result(TELC_READING_SCORING, 3)
    assert set(result) == {"kind", "points", "maxPoints"}
    assert "tdn" not in result and "scaledScore" not in result


def test_practice_formative_result_is_coverage_not_a_score():
    result = practice_formative_result(1, 2)
    assert result == {"kind": "practice_formative_result", "partsCompleted": 1, "totalParts": 2}
    assert "score" not in result and "points" not in result


def test_practice_formative_result_rejects_impossible_counts():
    with pytest.raises(GermanExamProfileError):
        practice_formative_result(3, 2)


def test_build_module_result_needs_objective_or_productive():
    with pytest.raises(GermanExamProfileError):
        build_module_result("reading")


def test_build_module_result_objective_only_telc_reports_official_score():
    result = build_module_result("reading", objective={"correct": 6, "total": 8, "scoring": TELC_READING_SCORING})
    assert result["kind"] == "module_result" and result["module"] == "reading"
    assert result["objective"] == {"kind": "practice_raw_result", "correct": 6, "total": 8, "percent": 75.0}
    assert result["official"] == {"kind": "official_style_scaled_result", "points": 6, "maxPoints": 8}
    assert "productive" not in result


def test_build_module_result_objective_only_testdaf_has_no_official_key():
    """TestDaF reading/listening parts carry no ScoringSpec (scoring=None). The module
    result must still report practice correctness, but must never add an "official" key —
    that would silently claim a legitimate scaled score exists when it does not."""
    result = build_module_result("reading", objective={"correct": 5, "total": 7, "scoring": None})
    assert result["objective"]["correct"] == 5
    assert "official" not in result


def test_build_module_result_productive_only_never_produces_a_numeric_score():
    result = build_module_result("speaking", productive={"partsCompleted": 3, "totalParts": 7})
    assert result["productive"] == {"kind": "practice_formative_result", "partsCompleted": 3, "totalParts": 7}
    assert "objective" not in result and "official" not in result
    assert not any(k in result for k in ("tdn", "pass", "scaledScore", "score"))


def test_build_module_result_never_returns_a_single_combined_exam_pass_fail():
    """There is no function anywhere in this module that accepts more than one module's
    data — every call is scoped to exactly one module, by construction."""
    import inspect

    import app.services.german_exams.result as result_module

    for name, fn in inspect.getmembers(result_module, inspect.isfunction):
        params = inspect.signature(fn).parameters
        assert not any(p in params for p in ("modules", "module_results")), (
            f"{name} appears to combine multiple modules; TestDaF (and every exam) must "
            "report modules separately, never one combined pass/fail"
        )

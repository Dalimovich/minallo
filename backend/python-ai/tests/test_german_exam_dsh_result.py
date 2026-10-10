"""DSH result calculator: exact boundaries, weighting, no compensation, invalid input.

Thresholds/weights verified against HRK DSH-MPO 2025 §5(2),(3),(5),(6) (57/67/82 %, 2:2:1:2) and the
Uni Duisburg-Essen point scale (700 written = 200/200/100/200, oral 300)."""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

import pytest

from app.services.german_exams import GermanExamProfileError
from app.services.german_exams.dsh_result import (
    calculate_dsh_result, level_for_share, oral_result, overall_result, threshold_points, written_result,
)


def _written(total: int) -> dict:
    """Spread `total` written points over HV/LV/WS/TP without exceeding any maximum (200/200/100/200)."""
    caps = {"hv": 200, "lv": 200, "ws": 100, "tp": 200}
    out, left = {}, total
    for k, cap in caps.items():
        out[k] = min(cap, left)
        left -= out[k]
    assert left == 0
    return out


@pytest.mark.parametrize("points,level", [
    (0, None), (398, None), (399, "DSH-1"), (468, "DSH-1"), (469, "DSH-2"), (573, "DSH-2"), (574, "DSH-3"), (700, "DSH-3"),
])
def test_written_boundaries(points: int, level: str | None) -> None:
    r = written_result(_written(points))
    assert r["level"] == level and r["passed"] is (level is not None) and r["points"] == points


@pytest.mark.parametrize("points,level", [
    (170, None), (171, "DSH-1"), (200, "DSH-1"), (201, "DSH-2"), (245, "DSH-2"), (246, "DSH-3"), (300, "DSH-3"),
])
def test_oral_boundaries(points: int, level: str | None) -> None:
    assert oral_result(points)["level"] == level


def test_threshold_points_are_the_verified_numbers() -> None:
    assert [threshold_points("written", lv) for lv in ("DSH-1", "DSH-2", "DSH-3")] == [399, 469, 574]
    assert [threshold_points("oral", lv) for lv in ("DSH-1", "DSH-2", "DSH-3")] == [171, 201, 246]


def test_fractional_points_use_exact_arithmetic() -> None:
    assert written_result({"hv": 199.5, "lv": 199.5, "ws": 0, "tp": 0})["level"] == "DSH-1"  # 399.0 exactly
    assert written_result({"hv": 199.5, "lv": 199.4, "ws": 0, "tp": 0})["level"] is None  # 398.9
    assert written_result({"hv": Decimal("200"), "lv": Decimal("200"), "ws": Decimal("74"), "tp": Decimal("0")})["level"] == "DSH-2"


def test_weighting_is_2_2_1_2() -> None:
    # WS counts once (max 100); HV, LV and TP twice (max 200 each).
    full_but_half_ws = written_result({"hv": 200, "lv": 200, "ws": 50, "tp": 200})
    assert full_but_half_ws["points"] == 650
    assert full_but_half_ws["percent"] == pytest.approx(92.86, abs=0.01)
    assert written_result({"hv": 100, "lv": 200, "ws": 100, "tp": 200})["parts"]["hv"]["percent"] == 50.0


def test_incomplete_written_has_no_level() -> None:
    r = written_result({"hv": 200, "lv": 200})
    assert r["status"] == "incomplete" and r["missing"] == ["ws", "tp"] and r["level"] is None


def test_no_compensation_between_written_and_oral() -> None:
    r = overall_result(written_result(_written(700)), oral_result(171))
    assert r["level"] == "DSH-1" and r["limitedBy"] == "oral" and r["compensation"] is False
    r = overall_result(written_result(_written(399)), oral_result(300))
    assert r["level"] == "DSH-1" and r["limitedBy"] == "written"
    r = overall_result(written_result(_written(574)), oral_result(246))
    assert r["level"] == "DSH-3" and r["limitedBy"] is None
    assert overall_result(written_result(_written(700)), oral_result(170))["status"] == "not_passed"


def test_failed_written_decides_without_the_oral_exam() -> None:  # §4(3): oral may be skipped
    r = overall_result(written_result(_written(398)), None)
    assert r["status"] == "not_passed" and r["limitedBy"] == "written" and r["level"] is None


def test_missing_component_is_incomplete_not_a_result() -> None:
    assert overall_result(written_result(_written(700)), None)["status"] == "incomplete"
    assert overall_result(None, oral_result(300))["status"] == "incomplete"
    assert overall_result(None, None)["level"] is None


def test_result_is_labelled_practice_and_carries_the_disclaimer() -> None:
    r = calculate_dsh_result(_written(600), 250)
    assert r["kind"] == "dsh_practice_result" and r["official"] is False
    assert "local regulations" in r["disclaimer"] and r["level"] == "DSH-3"


@pytest.mark.parametrize("bad", [-1, 201, float("nan"), float("inf"), True, "150", None, [150]])
def test_invalid_scores_are_rejected(bad) -> None:
    with pytest.raises(GermanExamProfileError):
        written_result({"hv": bad, "lv": 0, "ws": 0, "tp": 0})


def test_invalid_structure_is_rejected() -> None:
    with pytest.raises(GermanExamProfileError):
        written_result({"hv": 1, "lv": 1, "ws": 1, "tp": 1, "extra": 1})
    with pytest.raises(GermanExamProfileError):
        written_result({"hv": 1, "lv": 1, "ws": 101, "tp": 1})  # WS max is 100
    with pytest.raises(GermanExamProfileError):
        oral_result(301)
    with pytest.raises(GermanExamProfileError):
        overall_result(oral_result(10), None)  # wrong component kind in the written slot
    with pytest.raises(GermanExamProfileError):
        threshold_points("written", "DSH-4")
    with pytest.raises(GermanExamProfileError):
        level_for_share(Fraction(1), 0)

"""DSH result calculator — the dedicated, deterministic implementation of MPO §5.

Deliberately NOT part of the generic `result.py` (which refuses to combine modules): DSH is the one
exam whose official result IS a weighted combination, with its own thresholds. Everything here is a
pure function over numbers — no model calls, no I/O.

Rules implemented (HRK DSH-Musterprüfungsordnung 2025, §5):
  (2) written exam passed at >= 57 % of the requirements over HV, LV incl. WS, TP
  (3) weighting HV : LV : WS : TP = 2 : 2 : 1 : 2
  (5) oral exam passed at >= 57 %
  (6) DSH-1 / DSH-2 / DSH-3 need >= 57 / 67 / 82 % in BOTH the written AND the oral exam
No compensation: the overall level is the LOWER of the written and the oral level.

Point scale (700 written = 200/200/100/200, oral 300) is SECONDARY-sourced (Uni Duisburg-Essen); the
MPO itself defines only the ratio and the percentages. All comparisons use exact fractions so a
boundary such as 399/700 = 57 % can never be misjudged by float rounding.

The result is a PRACTICE ESTIMATE. It says so, and it carries the local-regulation disclaimer.
"""

from __future__ import annotations

import math
from decimal import Decimal
from fractions import Fraction
from typing import Any, Mapping

from .dsh import (
    DISCLAIMER,
    LEVEL_THRESHOLDS_PERCENT,
    ORAL_MAX_POINTS,
    PASS_THRESHOLD_PERCENT,
    RESULT_LEVELS,
    WRITTEN_MAX_POINTS,
)
from .shared import GermanExamProfileError

WRITTEN_PARTS = tuple(WRITTEN_MAX_POINTS)  # ("hv", "lv", "ws", "tp")
_RANK = {level: rank for rank, level in enumerate(RESULT_LEVELS, start=1)}


def _to_fraction(value: Any, label: str) -> Fraction:
    if isinstance(value, bool):
        raise GermanExamProfileError(f"{label}: a boolean is not a score")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise GermanExamProfileError(f"{label}: score must be finite")
        return Fraction(Decimal(str(value)))
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise GermanExamProfileError(f"{label}: score must be finite")
        return Fraction(value)
    raise GermanExamProfileError(f"{label}: score must be a number, got {type(value).__name__}")


def _checked(value: Any, maximum: int, label: str) -> Fraction:
    points = _to_fraction(value, label)
    if points < 0 or points > maximum:
        raise GermanExamProfileError(f"{label}: {float(points)} is outside 0..{maximum}")
    return points


def _number(value: Fraction) -> int | float:
    return int(value) if value.denominator == 1 else float(value)


def level_for_share(points: Fraction, maximum: int) -> str | None:
    """Highest level whose threshold is reached, or None below the 57 % pass line."""
    if maximum <= 0:
        raise GermanExamProfileError("maximum must be positive")
    for level in reversed(RESULT_LEVELS):
        if points * 100 >= LEVEL_THRESHOLDS_PERCENT[level] * maximum:
            return level
    return None


def threshold_points(component: str, level: str) -> int | float:
    """Points needed for `level` in the written exam or the oral exam (e.g. written/DSH-2 -> 469)."""
    if level not in LEVEL_THRESHOLDS_PERCENT:
        raise GermanExamProfileError(f"unknown DSH level: {level!r}")
    maximum = {"written": sum(WRITTEN_MAX_POINTS.values()), "oral": ORAL_MAX_POINTS}.get(component)
    if maximum is None:
        raise GermanExamProfileError(f"unknown component: {component!r}")
    return _number(Fraction(LEVEL_THRESHOLDS_PERCENT[level] * maximum, 100))


def written_result(scores: Mapping[str, Any]) -> dict[str, Any]:
    """`scores` maps hv/lv/ws/tp to points (each 0..its maximum). Missing parts -> status
    'incomplete' and NO level; unknown keys and out-of-range values raise."""
    unknown = sorted(set(scores) - set(WRITTEN_PARTS))
    if unknown:
        raise GermanExamProfileError(f"unknown written parts: {unknown}")
    parts = {part: _checked(scores[part], WRITTEN_MAX_POINTS[part], part) for part in WRITTEN_PARTS if part in scores}
    missing = [part for part in WRITTEN_PARTS if part not in parts]
    if missing:
        return {"kind": "dsh_written_result", "status": "incomplete", "missing": missing, "level": None}
    total_max = sum(WRITTEN_MAX_POINTS.values())
    total = sum(parts.values(), Fraction(0))
    level = level_for_share(total, total_max)
    return {
        "kind": "dsh_written_result",
        "status": "complete",
        "points": _number(total),
        "maxPoints": total_max,
        "percent": round(float(total * 100 / total_max), 2),
        "level": level,
        "passed": level is not None,
        "parts": {
            part: {
                "points": _number(parts[part]),
                "maxPoints": WRITTEN_MAX_POINTS[part],
                "percent": round(float(parts[part] * 100 / WRITTEN_MAX_POINTS[part]), 2),
            }
            for part in WRITTEN_PARTS
        },
    }


def oral_result(points: Any) -> dict[str, Any]:
    value = _checked(points, ORAL_MAX_POINTS, "oral")
    level = level_for_share(value, ORAL_MAX_POINTS)
    return {
        "kind": "dsh_oral_result",
        "status": "complete",
        "points": _number(value),
        "maxPoints": ORAL_MAX_POINTS,
        "percent": round(float(value * 100 / ORAL_MAX_POINTS), 2),
        "level": level,
        "passed": level is not None,
    }


def overall_result(written: Mapping[str, Any] | None, oral: Mapping[str, Any] | None) -> dict[str, Any]:
    """Combine a written and an oral component result per §5(1),(6). No compensation."""
    base = {
        "kind": "dsh_practice_result",
        "official": False,
        "basis": "HRK DSH-Musterprüfungsordnung 2025",
        "compensation": False,
        "passThresholdPercent": PASS_THRESHOLD_PERCENT,
        "disclaimer": DISCLAIMER,
        "written": dict(written) if written else None,
        "oral": dict(oral) if oral else None,
    }
    for name, component, kind in (("written", written, "dsh_written_result"), ("oral", oral, "dsh_oral_result")):
        if component is not None and component.get("kind") != kind:
            raise GermanExamProfileError(f"{name} component must be a {kind}")
    written_done = bool(written and written.get("status") == "complete")
    oral_done = bool(oral and oral.get("status") == "complete")
    # §4(3): the oral exam may be skipped once the written exam is failed, so a failed written
    # exam already decides the outcome.
    if written_done and written["level"] is None:
        return {**base, "status": "not_passed", "level": None, "limitedBy": "written"}
    if not written_done or not oral_done:
        missing = [n for n, done in (("written", written_done), ("oral", oral_done)) if not done]
        return {**base, "status": "incomplete", "level": None, "missing": missing}
    if oral["level"] is None:
        return {**base, "status": "not_passed", "level": None, "limitedBy": "oral"}
    level = min((written["level"], oral["level"]), key=_RANK.__getitem__)
    limited_by = None if written["level"] == oral["level"] else ("written" if _RANK[written["level"]] < _RANK[oral["level"]] else "oral")
    return {**base, "status": "passed", "level": level, "limitedBy": limited_by}


def calculate_dsh_result(written_scores: Mapping[str, Any] | None = None, oral_points: Any = None) -> dict[str, Any]:
    """Convenience: raw part points in, practice result out."""
    written = written_result(written_scores) if written_scores is not None else None
    oral = oral_result(oral_points) if oral_points is not None else None
    return overall_result(written, oral)

"""Module-separated exam-result representation, shared by every exam profile.

Distinguishes three kinds of result so a profile without a published raw-to-scaled
conversion (Digital TestDaF, currently) can never be shown an invented official score:

- practice_raw_result: item correctness computed locally (objective modules).
  Always available; never claims to be an official result.
- official_style_scaled_result: points/maxPoints(/pass), only when the caller supplies a
  verified `ScoringSpec` (see shared.py). Omitted — never fabricated — otherwise. A `pass`
  key is included only when the spec itself carries a verified pass mark.
- practice_formative_result: writing/speaking coverage (tasks submitted / total). Never a
  numeric score — those modules are graded per-dimension text (see german_exam_productive.py
  / german_exam_writing_grading.py), not converted to a point total here.

There is deliberately no function here that combines multiple modules into one result:
every exam family (TestDaF explicitly, per its own published scoring policy) reports
modules separately. Callers build one `module_result` per module and render/store them
separately — never sum them into a single PASS/FAIL.

A TDN classification is NOT computed here. TestDaF's TDN bands (see testdaf_digital.py
SCORING_METADATA/TDN_BANDS) describe the official 0-20 scaled-score ranges, but the raw
item count -> 0-20 scaled score conversion itself is not published in any source this
implementation has verified. Inventing that conversion — even to only label a TDN band —
would fabricate an official result, which this module refuses to do.
"""

from __future__ import annotations

from typing import Any

from .scoring import is_pass, raw_to_points
from .shared import GermanExamProfileError, ScoringSpec


def practice_raw_result(correct: int, total: int) -> dict[str, Any]:
    if total < 0 or correct < 0 or correct > total:
        raise GermanExamProfileError("invalid raw correctness counts")
    percent = round(100 * correct / total, 1) if total else None
    return {"kind": "practice_raw_result", "correct": correct, "total": total, "percent": percent}


def official_style_scaled_result(scoring: ScoringSpec | None, raw_correct: int) -> dict[str, Any] | None:
    """None when no verified official conversion is available for this scope — the caller
    must not invent one. `pass` is included only when the spec itself has a verified mark;
    it is never defaulted to False."""
    if scoring is None:
        return None
    points = raw_to_points(scoring, raw_correct)
    result: dict[str, Any] = {"kind": "official_style_scaled_result", "points": points, "maxPoints": scoring.max_points}
    if scoring.pass_points is not None:
        result["pass"] = is_pass(scoring, points)
    return result


def practice_formative_result(parts_completed: int, total_parts: int) -> dict[str, Any]:
    if total_parts < 0 or parts_completed < 0 or parts_completed > total_parts:
        raise GermanExamProfileError("invalid formative coverage counts")
    return {"kind": "practice_formative_result", "partsCompleted": parts_completed, "totalParts": total_parts}


def build_module_result(
    module_id: str,
    *,
    objective: dict[str, Any] | None = None,
    productive: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One module's result only. `objective` (when the module has objective parts) is
    {"correct": int, "total": int, "scoring": ScoringSpec | None}. `productive` (when the
    module has writing/speaking parts) is {"partsCompleted": int, "totalParts": int}. A
    module may supply both (none of the current profiles mix them, but nothing here assumes
    they can't) or exactly one. Raises if given neither — callers must not invent a result
    for a module that has nothing to report yet."""
    if objective is None and productive is None:
        raise GermanExamProfileError("module result needs objective and/or productive data")
    result: dict[str, Any] = {"kind": "module_result", "module": module_id}
    if objective is not None:
        result["objective"] = practice_raw_result(objective["correct"], objective["total"])
        official = official_style_scaled_result(objective.get("scoring"), objective["correct"])
        if official is not None:
            result["official"] = official
    if productive is not None:
        result["productive"] = practice_formative_result(productive["partsCompleted"], productive["totalParts"])
    return result

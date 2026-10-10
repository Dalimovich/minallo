"""Generic receptive scoring shared by every exam profile.

Pure functions over `ScoringSpec` (see shared.py). Exam-specific numbers (the
official raw -> result table, pass marks) live in each exam's profile file;
nothing here knows about a particular exam.
"""

from __future__ import annotations

from .shared import (
    SCORING_FIXED_PER_ITEM,
    SCORING_LOOKUP_TABLE,
    GermanExamProfileError,
    ScoringSpec,
)


def raw_to_points(spec: ScoringSpec, raw_correct: int) -> int:
    """Points for `raw_correct` correctly solved items.

    fixed_per_item: raw * points_per_correct (telc's behaviour, unchanged).
    lookup_table:   the official conversion table, never arithmetic.
    """
    mode = spec.resolved_mode
    if mode == SCORING_FIXED_PER_ITEM:
        if spec.points_per_correct is None:
            raise GermanExamProfileError("fixed_per_item scoring needs points_per_correct")
        return raw_correct * spec.points_per_correct
    if mode == SCORING_LOOKUP_TABLE:
        table = spec.raw_to_result_points
        assert table is not None  # enforced by ScoringSpec.__post_init__
        if not 0 <= raw_correct < len(table):
            raise GermanExamProfileError(f"raw score {raw_correct} outside 0..{len(table) - 1}")
        return table[raw_correct]
    raise GermanExamProfileError(f"scoring mode {mode!r} is not item-based")


def is_pass(spec: ScoringSpec, points: float) -> bool:
    if spec.pass_points is None:
        raise GermanExamProfileError("this scoring spec has no pass mark")
    return points >= spec.pass_points

"""Adaptation planner: pure-function tests. The planner must never emit an
instruction whose axis lies outside the part blueprint's allowed_adaptations
(that would mean it could implicitly ask for a different item count/task
type/option count), and cold start must yield an empty plan."""

from __future__ import annotations

import pytest

from app.services.german_exam_adaptation import (
    AdaptationInstruction,
    TagWeakness,
    WeaknessReport,
    build_adaptation_plan,
)
from app.services.german_exam_profiles import get_part

HV1 = get_part("telc_c1_hochschule", "listening", "hv1")


def test_cold_start_yields_empty_plan() -> None:
    report = WeaknessReport(tags={}, overall_confidence="cold_start")
    plan = build_adaptation_plan(HV1, "C1 Hochschule", report)
    assert plan == []


def test_below_threshold_tags_are_not_targeted() -> None:
    # confidence "cold_start" means fewer than the minimum attempts — weakest() excludes them.
    report = WeaknessReport(
        tags={"paraphrase_mapping": TagWeakness(tag="paraphrase_mapping", score=0.1, n_attempts=1, confidence="cold_start")},
        overall_confidence="cold_start",
    )
    plan = build_adaptation_plan(HV1, "C1 Hochschule", report)
    assert plan == []


def test_weak_tag_produces_instruction_within_allowed_adaptations() -> None:
    report = WeaknessReport(
        tags={"paraphrase_mapping": TagWeakness(tag="paraphrase_mapping", score=0.2, n_attempts=5, confidence="medium")},
        overall_confidence="medium",
    )
    plan = build_adaptation_plan(HV1, "C1 Hochschule", report)
    assert plan, "expected at least one instruction for a real weakness"
    for instr in plan:
        assert instr.axis in HV1.allowed_adaptations
        assert isinstance(instr, AdaptationInstruction)


def test_plan_never_contains_structural_keys() -> None:
    """The planner's own output shape can never carry item-count/task-type/
    option-count style keys — it only ever emits {axis, direction, targetTags}."""
    report = WeaknessReport(
        tags={
            "paraphrase_mapping": TagWeakness(tag="paraphrase_mapping", score=0.1, n_attempts=8, confidence="high"),
            "speaker_opinion": TagWeakness(tag="speaker_opinion", score=0.2, n_attempts=6, confidence="medium"),
        },
        overall_confidence="high",
    )
    plan = build_adaptation_plan(HV1, "C1 Hochschule", report)
    for instr in plan:
        fields = vars(instr).keys()
        assert fields == {"axis", "direction", "target_tags"}


def test_weakest_limits_to_top_n() -> None:
    report = WeaknessReport(
        tags={
            "a": TagWeakness(tag="a", score=0.1, n_attempts=5, confidence="medium"),
            "b": TagWeakness(tag="b", score=0.2, n_attempts=5, confidence="medium"),
            "c": TagWeakness(tag="c", score=0.3, n_attempts=5, confidence="medium"),
            "d": TagWeakness(tag="d", score=0.4, n_attempts=5, confidence="medium"),
        },
        overall_confidence="medium",
    )
    assert len(report.weakest(3)) == 3
    assert [t.tag for t in report.weakest(3)] == ["a", "b", "c"]


LESEN1 = get_part("telc_c1_hochschule", "reading", "lesen_1")
LESEN3 = get_part("telc_c1_hochschule", "reading", "lesen_3")


def test_lesen1_weak_reference_resolution_targets_reference_complexity() -> None:
    report = WeaknessReport(
        tags={"reference_resolution": TagWeakness(tag="reference_resolution", score=0.1, n_attempts=5, confidence="medium")},
        overall_confidence="medium",
    )
    plan = build_adaptation_plan(LESEN1, "C1 Hochschule", report)
    assert plan, "expected at least one instruction for a real reading weakness"
    for instr in plan:
        assert instr.axis in LESEN1.allowed_adaptations


def test_lesen3_weak_author_intention_targets_explicitness_axis() -> None:
    report = WeaknessReport(
        tags={"author_intention": TagWeakness(tag="author_intention", score=0.1, n_attempts=5, confidence="medium")},
        overall_confidence="medium",
    )
    plan = build_adaptation_plan(LESEN3, "C1 Hochschule", report)
    assert any(instr.axis == "author_intention_explicitness" and instr.direction == "decrease" for instr in plan)


SCHREIBEN = get_part("telc_c1_hochschule", "writing", "schreiben_1")


def test_schreiben_weak_task_fulfilment_targets_complexity_axis_within_allowed_adaptations() -> None:
    report = WeaknessReport(
        tags={"task_fulfilment": TagWeakness(tag="task_fulfilment", score=0.2, n_attempts=5, confidence="medium")},
        overall_confidence="medium",
    )
    plan = build_adaptation_plan(SCHREIBEN, "C1 Hochschule", report)
    assert any(instr.axis == "task_fulfilment_complexity" for instr in plan)
    for instr in plan:
        assert instr.axis in SCHREIBEN.allowed_adaptations


def test_schreiben_weak_cohesion_targets_cohesion_demand_axis() -> None:
    report = WeaknessReport(
        tags={"cohesion": TagWeakness(tag="cohesion", score=0.15, n_attempts=6, confidence="medium")},
        overall_confidence="medium",
    )
    plan = build_adaptation_plan(SCHREIBEN, "C1 Hochschule", report)
    assert any(instr.axis == "cohesion_demand" and instr.direction == "increase" for instr in plan)


# ── _attempt_score: productive-skill (writing/speaking) fallback ───────────
# These rows never have first_attempt_correct/final_correct populated (see
# german_exam_writing_grading.py) — _attempt_score() must derive the score
# from score_value/max_score_value instead of treating "no boolean" as wrong.


def test_attempt_score_uses_rubric_ratio_when_correctness_is_null() -> None:
    from app.services.german_exam_adaptation import _attempt_score

    row = {"first_attempt_correct": None, "final_correct": None, "score_value": 80, "max_score_value": 100}
    assert _attempt_score(row) == pytest.approx(0.8)


def test_attempt_score_clamps_rubric_ratio_to_unit_range() -> None:
    from app.services.german_exam_adaptation import _attempt_score

    over = {"first_attempt_correct": None, "final_correct": None, "score_value": 120, "max_score_value": 100}
    assert _attempt_score(over) == 1.0
    under = {"first_attempt_correct": None, "final_correct": None, "score_value": -10, "max_score_value": 100}
    assert _attempt_score(under) == 0.0


def test_attempt_score_falls_back_to_zero_with_no_score_signal_at_all() -> None:
    from app.services.german_exam_adaptation import _attempt_score

    row = {"first_attempt_correct": None, "final_correct": None, "score_value": None, "max_score_value": None}
    assert _attempt_score(row) == 0.0


def test_attempt_score_still_uses_boolean_path_for_objective_items() -> None:
    from app.services.german_exam_adaptation import _attempt_score

    row = {"first_attempt_correct": True, "final_correct": True, "hint_level": 0, "transcript_revealed": False}
    assert _attempt_score(row) == 1.0


# ── compute_weakness: writing rubric dimensions feed the same per-tag
# weighted average an objective item does ──────────────────────────────────


class _FakeQuery:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        class _Resp:
            def __init__(self, data):
                self.data = data
        return _Resp(self._rows)


class _FakeSB:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def table(self, _name):
        return _FakeQuery(self._rows)


def test_compute_weakness_consumes_writing_rubric_dimension_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_adaptation as mod

    rows = [
        {
            "skill_tags": ["task_fulfilment"], "first_attempt_correct": None, "final_correct": None,
            "hint_level": None, "replay_count": None, "transcript_revealed": None, "attempted_at": None,
            "score_value": 40, "max_score_value": 100,
        }
        for _ in range(5)
    ]
    monkeypatch.setattr(mod, "get_supabase", lambda: _FakeSB(rows))

    report = mod.compute_weakness("u1", "telc_c1_hochschule", "writing")
    assert "task_fulfilment" in report.tags
    tag = report.tags["task_fulfilment"]
    assert tag.score == pytest.approx(0.4)
    assert tag.confidence in ("low", "medium", "high")

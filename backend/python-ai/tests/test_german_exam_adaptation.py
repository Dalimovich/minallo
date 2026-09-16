"""Adaptation planner: pure-function tests. The planner must never emit an
instruction whose axis lies outside the part blueprint's allowed_adaptations
(that would mean it could implicitly ask for a different item count/task
type/option count), and cold start must yield an empty plan."""

from __future__ import annotations

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

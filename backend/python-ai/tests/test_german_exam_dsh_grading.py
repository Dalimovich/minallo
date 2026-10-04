"""DSH HV/LV learner-answer grading — offline: scripted fakes only, no real provider calls.

Everything here is a MOCKED semantic-grading test (schema validation, aggregation, retry/error
handling, prompt contract against a fake chat_json provider). None of it is LIVE semantic-grading
validation: no OpenAI credentials are available in this environment, so llm_content_matcher has
never been executed against a real model. That remains a MODEL/LIVE DEPENDENCY."""

from __future__ import annotations

from fractions import Fraction

import pytest

from app.services.german_exam_dsh_grading import (
    DshGradingError,
    grade_dsh_open_answer_item,
    grade_dsh_open_answer_part,
    llm_content_matcher,
)
from app.services.german_exams.dsh_content_model import ContentPoint, DshContentError, OpenAnswerItem

QUESTION = "Worum geht es in dem Abschnitt?"


def _item(point_count: int = 1, points_each: int = 1) -> OpenAnswerItem:
    points = tuple(
        ContentPoint(point_id=f"p{i}", description=f"Punkt {i}", points=Fraction(points_each))
        for i in range(1, point_count + 1)
    )
    return OpenAnswerItem(
        item_id="q1", task_form="questions", question=QUESTION,
        max_points=Fraction(points_each * point_count), required_points=points,
    )


class _Result:
    def __init__(self, data) -> None:
        self.data = data
        self.completion_tokens = 10
        self.reasoning_tokens = 0


def _scripted_provider(*responses):
    calls: list[dict] = []

    def provider(**kwargs):
        calls.append(kwargs)
        return _Result(responses[len(calls) - 1])

    provider.calls = calls  # type: ignore[attr-defined]
    return provider


# ---- llm_content_matcher: mocked schema/retry/contract behaviour ------------------------------
def test_mocked_matcher_returns_the_ids_the_model_reports() -> None:
    item = _item(point_count=2)
    provider = _scripted_provider({"matchedPointIds": ["p1"]})
    matched = llm_content_matcher(item.question, "Teilantwort.", item.required_points, provider=provider)
    assert matched == {"p1"}


def test_mocked_matcher_filters_out_ids_the_model_hallucinated() -> None:
    """A hallucinated/unknown id must never reach score_content_item (which would raise) —
    this is new, learner-facing capability, so a model glitch must not crash grading."""
    item = _item(point_count=1)
    provider = _scripted_provider({"matchedPointIds": ["p1", "nonexistent"]})
    matched = llm_content_matcher(item.question, "x", item.required_points, provider=provider)
    assert matched == {"p1"}


def test_mocked_matcher_with_no_points_short_circuits_without_calling_the_model() -> None:
    provider = _scripted_provider()
    matched = llm_content_matcher(QUESTION, "irrelevant", (), provider=provider)
    assert matched == set()
    assert provider.calls == []


def test_mocked_matcher_retries_once_on_a_malformed_response_then_succeeds() -> None:
    item = _item(point_count=1)
    provider = _scripted_provider({"not": "the expected shape"}, {"matchedPointIds": ["p1"]})
    matched = llm_content_matcher(item.question, "x", item.required_points, provider=provider)
    assert matched == {"p1"}
    assert len(provider.calls) == 2


def test_mocked_matcher_raises_dsh_grading_error_after_exhausting_retries() -> None:
    """The semantic-model-failure case: every attempt returns a malformed response."""
    item = _item(point_count=1)
    provider = _scripted_provider({}, {}, {"matchedPointIds": "not-a-list"})
    with pytest.raises(DshGradingError):
        llm_content_matcher(item.question, "x", item.required_points, provider=provider)


def test_mocked_matcher_prompt_mentions_the_question_and_every_point_id() -> None:
    """Prompt-contract check: the content the matcher is asked to judge must actually be in
    the prompt sent to the model, not just implied by arguments that get dropped."""
    item = _item(point_count=2)
    provider = _scripted_provider({"matchedPointIds": []})
    llm_content_matcher(item.question, "meine Antwort", item.required_points, provider=provider)
    sent = provider.calls[0]
    assert item.question in sent["user"]
    assert "meine Antwort" in sent["user"]
    assert "p1" in sent["user"] and "p2" in sent["user"]


# ---- grade_dsh_open_answer_item: fully correct / partial / incorrect / empty / multi-point ----
def test_fully_correct_answer_scores_full_marks() -> None:
    item = _item(point_count=2)
    matcher = lambda question, answer, points: {"p1", "p2"}  # noqa: E731
    result = grade_dsh_open_answer_item(item, "eine vollständige Antwort", matcher=matcher)
    assert result == {"itemId": "q1", "points": Fraction(2), "maxPoints": Fraction(2), "matchedPointIds": ["p1", "p2"]}


def test_partially_correct_answer_scores_only_the_matched_points() -> None:
    item = _item(point_count=3)
    matcher = lambda question, answer, points: {"p2"}  # noqa: E731
    result = grade_dsh_open_answer_item(item, "teilweise richtig", matcher=matcher)
    assert result["points"] == Fraction(1) and result["maxPoints"] == Fraction(3)
    assert result["matchedPointIds"] == ["p2"]


def test_incorrect_answer_scores_zero() -> None:
    item = _item(point_count=2)
    matcher = lambda question, answer, points: set()  # noqa: E731
    result = grade_dsh_open_answer_item(item, "völlig falsche Antwort", matcher=matcher)
    assert result["points"] == Fraction(0)


def test_empty_answer_scores_zero_and_reaches_the_matcher_as_empty_string() -> None:
    item = _item(point_count=1)
    seen: dict = {}

    def matcher(question, answer, points):
        seen["answer"] = answer
        return set()

    result = grade_dsh_open_answer_item(item, "", matcher=matcher)
    assert result["points"] == Fraction(0)
    assert seen["answer"] == ""

    seen.clear()
    result_none = grade_dsh_open_answer_item(item, None, matcher=matcher)  # type: ignore[arg-type]
    assert result_none["points"] == Fraction(0)
    assert seen["answer"] == ""


def test_multiple_content_points_with_uneven_weights_sum_correctly() -> None:
    points = (
        ContentPoint(point_id="p1", description="A", points=Fraction(2)),
        ContentPoint(point_id="p2", description="B", points=Fraction(1)),
        ContentPoint(point_id="p3", description="C", points=Fraction(3)),
    )
    item = OpenAnswerItem(item_id="q1", task_form="questions", question=QUESTION, max_points=Fraction(6), required_points=points)
    matcher = lambda question, answer, pts: {"p1", "p3"}  # noqa: E731
    result = grade_dsh_open_answer_item(item, "A und C", matcher=matcher)
    assert result["points"] == Fraction(5)


# ---- grade_dsh_open_answer_part: aggregation, malformed content, semantic-model failure -------
def _content(item_count: int = 2) -> dict:
    items = [
        {"itemId": f"q{i}", "question": f"Frage {i}?", "requiredPoints": [{"pointId": f"p{i}", "description": f"Punkt {i}", "points": 1}]}
        for i in range(1, item_count + 1)
    ]
    return {"sourceId": "src-1", "source": {"text": "ein Text."}, "tasks": [{"form": "questions", "items": items}]}


def test_deterministic_result_aggregation_across_multiple_items() -> None:
    content = _content(item_count=3)
    # q1 fully correct, q2 incorrect, q3 fully correct -> 2/3 raw points.
    matcher = lambda question, answer, points: ({p.point_id for p in points} if answer == "correct" else set())  # noqa: E731
    answers = {"q1": "correct", "q2": "wrong", "q3": "correct"}
    result = grade_dsh_open_answer_part(content, answers, matcher=matcher)
    assert result["rawPoints"] == Fraction(2) and result["rawMaxPoints"] == Fraction(3)
    assert result["percent"] == pytest.approx(66.67, abs=0.01)
    assert [i["itemId"] for i in result["items"]] == ["q1", "q2", "q3"]
    assert result["officialScale"] is None, "the official 200-point DSH scale must not be invented here"


def test_a_perfect_raw_score_still_does_not_imply_or_emit_an_official_200_point_value() -> None:
    """Regression for the dedicated evidence phase that investigated the raw-LV/HV -> official
    DSH score conversion and concluded CONVERSION NOT ESTABLISHED (no authoritative source gives
    a formula, or even the underlying raw-point totals, for HV/LV — see this module's own
    docstring). A perfect raw score's percent happens to be a "nice" number; that coincidence
    must never be mistaken for, or silently promoted into, an official/secondary-scaled figure."""
    content = _content(item_count=1)
    matcher = lambda question, answer, points: {p.point_id for p in points}  # noqa: E731
    result = grade_dsh_open_answer_part(content, {"q1": "correct"}, matcher=matcher)
    assert result["rawPoints"] == result["rawMaxPoints"] == Fraction(1)
    assert result["percent"] == 100.0
    assert result["officialScale"] is None
    assert "200" not in str(result) and "dshResult" not in result and "level" not in result


def test_missing_learner_answer_for_an_item_is_treated_as_empty_not_an_error() -> None:
    content = _content(item_count=2)
    matcher = lambda question, answer, points: set()  # noqa: E731
    result = grade_dsh_open_answer_part(content, {"q1": "something"}, matcher=matcher)  # q2 has no answer at all
    assert result["rawPoints"] == Fraction(0)
    assert len(result["items"]) == 2


def test_malformed_content_missing_required_points_raises_dsh_content_error() -> None:
    content = {"sourceId": "src-1", "source": {"text": "x"}, "tasks": [{"form": "questions", "items": [
        {"itemId": "q1", "question": "Frage?", "requiredPoints": []},
    ]}]}
    with pytest.raises(DshContentError):
        grade_dsh_open_answer_part(content, {"q1": "irrelevant"}, matcher=lambda *a: set())


def test_semantic_model_failure_during_part_grading_propagates_and_does_not_silently_score() -> None:
    content = _content(item_count=1)

    def failing_matcher(question, answer, points):
        raise DshGradingError("content matcher failed to return a usable response: simulated")

    with pytest.raises(DshGradingError):
        grade_dsh_open_answer_part(content, {"q1": "x"}, matcher=failing_matcher)

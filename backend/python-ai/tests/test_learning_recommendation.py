from __future__ import annotations

from app.services.learning_recommendation import (
    ExplanationDepth,
    build_explanation_plan,
    build_learning_recommendations,
)
from app.services.visual_aids import VisualContext, select_visual_aids


def test_explicit_explanation_builds_detailed_plan() -> None:
    plan = build_explanation_plan("Explain Gesenkschmieden step by step")
    assert plan.explanation_requested is True
    assert plan.depth == ExplanationDepth.DETAILED
    assert plan.include_step_by_step is True
    assert plan.topic == "Gesenkschmieden"


def test_confusion_is_a_real_signal_without_personal_claim() -> None:
    plan = build_explanation_plan("I don't understand logarithmic strain")
    recommendations = build_learning_recommendations(
        plan,
        course_id="course-a",
        document_ids=["doc-a"],
        source_chunk_ids=["chunk-a"],
    )
    assert recommendations[0]["reasonCode"] == "user_confusion_statement"
    assert "weak" not in recommendations[0]["reasonText"].lower()


def test_low_mastery_requires_real_matching_record() -> None:
    plan = build_explanation_plan(
        "Explain true strain",
        weak_topics=["true strain"],
    )
    recommendations = build_learning_recommendations(
        plan,
        course_id="course-a",
        document_ids=[],
        source_chunk_ids=[],
        weak_topics=["true strain"],
    )
    assert recommendations[0]["reasonCode"] == "low_mastery"


def test_trivial_question_does_not_recommend() -> None:
    plan = build_explanation_plan("Hello")
    assert (
        build_learning_recommendations(
            plan,
            course_id="course-a",
            document_ids=[],
            source_chunk_ids=[],
        )
        == []
    )


def test_deictic_only_topic_does_not_recommend() -> None:
    """Confirmed 2026-10-21 production incident: "explain this to me"
    (no real noun left once the "explain" prefix is stripped -- this
    function has no document content to resolve "this" against, only the
    literal question text) surfaced a "Start Deep Learn: this to me"
    recommendation. Recommending a lesson on a non-topic is worse than
    recommending none."""
    plan = build_explanation_plan("explain this to me")
    assert plan.topic == "this to me"
    assert (
        build_learning_recommendations(
            plan,
            course_id="course-a",
            document_ids=["doc-a"],
            source_chunk_ids=["chunk-a"],
        )
        == []
    )


def test_deictic_only_topic_in_german_does_not_recommend() -> None:
    plan = build_explanation_plan("erkläre mir das bitte")
    assert (
        build_learning_recommendations(
            plan,
            course_id="course-a",
            document_ids=["doc-a"],
            source_chunk_ids=["chunk-a"],
        )
        == []
    )


def test_a_real_topic_that_happens_to_include_this_still_recommends() -> None:
    """Non-regression: the deictic-only check requires the topic to
    consist ENTIRELY of filler words -- a real topic that happens to
    include one of them (e.g. "this" as part of a real noun phrase) is
    unaffected."""
    plan = build_explanation_plan("explain this stress-strain curve in detail")
    assert plan.topic not in ("this", "")
    recommendations = build_learning_recommendations(
        plan,
        course_id="course-a",
        document_ids=["doc-a"],
        source_chunk_ids=["chunk-a"],
    )
    assert recommendations != []


def test_selected_course_region_precedes_web_lookup() -> None:
    plan = build_explanation_plan(
        "Explain this diagram",
        has_selected_region=True,
        has_page_image=True,
    )
    aids = select_visual_aids(
        plan,
        context=VisualContext(
            document_id="doc-a",
            document_revision="rev-a",
            page_number=18,
            selected_region={
                "id": "region-a",
                "page": 18,
                "x": 0.1,
                "y": 0.2,
                "width": 0.5,
                "height": 0.4,
            },
            page_image_available=True,
        ),
    )
    assert len(aids) == 1
    assert aids[0]["sourceType"] == "course_file"
    assert aids[0]["visualId"] == "region-a"
    assert aids[0]["pageNumber"] == 18
    assert aids[0]["boundingBox"]["x"] == 0.1


def test_visual_ids_transfer_to_deep_learn_launch() -> None:
    plan = build_explanation_plan("Explain this diagram", has_selected_region=True)
    recommendations = build_learning_recommendations(
        plan,
        course_id="course-a",
        document_ids=["doc-a"],
        source_chunk_ids=["chunk-a"],
        visual_ids=["region-a", "region-a"],
    )
    assert recommendations[0]["visualIds"] == ["region-a"]

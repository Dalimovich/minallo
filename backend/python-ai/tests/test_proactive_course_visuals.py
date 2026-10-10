from app.services.course_visual_indexing import detect_visual_regions
from app.services.deep_learn_reuse import launch_idempotency_key, topic_fingerprint
from app.services.learning_recommendation import ExplanationIntent, build_explanation_plan


def test_detailed_german_process_request_activates_explicit_intents():
    plan = build_explanation_plan(
        "Erkläre Gesenkschmieden im Detail und zeige mir, wie es funktioniert.",
        has_page_image=True,
    )
    assert plan.depth.value in {"detailed", "deep"}
    assert ExplanationIntent.DETAILED_EXPLANATION.value in plan.answer_intents
    assert ExplanationIntent.PROCESS_EXPLANATION.value in plan.answer_intents
    assert ExplanationIntent.DEEP_LEARN_RECOMMENDATION.value in plan.answer_intents


def test_short_fact_does_not_overtrigger_deep_learning():
    plan = build_explanation_plan("Was ist DIN?")
    assert plan.depth.value != "deep"
    assert not plan.recommend_deep_learn


def test_visual_detection_keeps_caption_crop_and_rejects_footer():
    regions = detect_visual_regions(
        ["Gesenkschmieden\nAbb. 4 Werkstofffluss beim Gesenkschmieden\nSeite 18"],
        [[
            {"t": "Abb. 4 Werkstofffluss beim Gesenkschmieden", "bbox": [0.15, 0.55, 0.8, 0.62]},
            {"t": "Seite 18", "bbox": [0.45, 0.96, 0.55, 0.98]},
        ]],
        ["Gesenkschmieden"],
    )
    assert len(regions) == 1
    assert regions[0].page_number == 1
    assert regions[0].bbox["y"] < 0.55
    assert "Gesenkschmieden" in regions[0].description


def test_deep_learn_idempotency_is_stable_and_revision_sensitive():
    args = dict(user_id="u", course_id="c", topic="Die Forging", revision_hash="r1",
                lesson_mode="professor", lesson_language="en", recommendation_id="rec")
    assert launch_idempotency_key(**args) == launch_idempotency_key(**args)
    assert launch_idempotency_key(**args) != launch_idempotency_key(**{**args, "revision_hash": "r2"})
    assert topic_fingerprint("  Die-Forging ") == topic_fingerprint("die forging")

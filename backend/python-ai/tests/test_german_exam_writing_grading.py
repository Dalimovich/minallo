"""german_exam_writing_grading.py is a thin adapter over the EXISTING Writing
Coach evaluator (writing_coach.analyse_writing) — these tests mock that one
call and assert the mapping onto the official telc rubric + examResultItems
shape, WITHOUT spinning up a second grading engine. Also asserts every
persisted item has null correctness fields (writing is not binary-correct)."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ.setdefault("INTERNAL_SECRET", "stub")


def _fake_analysis(**overrides) -> dict:
    base = {
        "profileLevel": "C1 Hochschule",
        "taskType": "stellungnahme",
        "estimatedLevel": "C1",
        "score": {"overall": 75, "grammar": 80, "vocabulary": 70, "structure": 72, "style": 68, "taskFulfillment": 85},
        "scoreExplanation": "Solid C1 essay.",
        "correctedText": "...",
        "improvedText": "...",
        "strengths": ["Clear argument"],
        "feedbackItems": [],
        "structureFeedback": {"verdict": "adequate", "missing": [], "note": "..."},
        "examReadiness": {"wouldPass": True, "verdict": "likely", "missing": [], "note": "..."},
        "practiceRecommendations": [],
        "longitudinalNote": None,
        "insufficientContext": None,
        "model": "stub-model",
        "promptTokens": 100,
        "completionTokens": 200,
    }
    base.update(overrides)
    return base


def test_grades_via_the_existing_writing_coach_evaluator_not_a_second_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_writing_grading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    calls = {"n": 0, "kwargs": None}

    def _fake_analyse_writing(**kwargs):
        calls["n"] += 1
        calls["kwargs"] = kwargs
        return _fake_analysis()

    monkeypatch.setattr(mod, "analyse_writing", _fake_analyse_writing)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    result = mod.grade_writing_submission(
        user_id="u1", profile=profile, part=part, generation_id="gen-1",
        writing_coach_task_type="stellungnahme", text="Ein ausführlicher Text über Nachhaltigkeit ..." * 5,
        selected_topic={"questionId": "b", "title": "Nachhaltigkeit", "taskInstructions": "Begründen Sie Ihre Position."},
    )

    assert calls["n"] == 1  # exactly one call to the shared evaluator, not two grading paths
    assert calls["kwargs"]["profile_level"] == "C1 Hochschule"
    assert calls["kwargs"]["task_type"] == "stellungnahme"
    assert calls["kwargs"]["exam_context"]["selectedTopic"]["questionId"] == "b"
    assert calls["kwargs"]["exam_context"]["targetLevel"] == "C1 Hochschule"
    assert result["analysis"]["score"]["overall"] == 75


def test_rubric_maps_analyse_writing_axes_onto_telc_dimensions(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_writing_grading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "analyse_writing", lambda **kwargs: _fake_analysis())

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    result = mod.grade_writing_submission(
        user_id="u1", profile=profile, part=part, generation_id="gen-1",
        writing_coach_task_type="stellungnahme", text="text",
    )

    rubric = result["rubric"]
    assert rubric["taskFulfilment"] == 85
    assert rubric["correctness"] == 80  # grammar axis
    assert rubric["repertoire"] == 70  # vocabulary axis
    assert rubric["communicativeDesign"] == pytest.approx((72 + 68) / 2)  # avg(structure, style)
    assert rubric["overall"] == pytest.approx((85 + 80 + 70 + 70) / 4)
    assert rubric["examMaxScoreValue"] == 48
    assert rubric["examScoreValue"] == round(rubric["overall"] / 100 * 48, 1)


def test_exam_result_items_have_null_correctness_and_populated_score(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_writing_grading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "analyse_writing", lambda **kwargs: _fake_analysis())

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    result = mod.grade_writing_submission(
        user_id="u1", profile=profile, part=part, generation_id="gen-1",
        writing_coach_task_type="stellungnahme", text="text",
    )

    items = result["examResultItems"]
    assert len(items) == 4  # task_fulfilment, correctness, repertoire, communicative_design
    for item in items:
        assert item["firstAttemptCorrect"] is None
        assert item["finalCorrect"] is None
        assert item["scoreValue"] is not None
        assert item["maxScoreValue"] == 100
        assert item["module"] == "writing"
        assert item["partId"] == "schreiben_1"
        assert item["generationId"] == "gen-1"
        assert item["metadata"]["rubric"] == result["rubric"]
        # Every skill tag used must be a member of the part's allowed vocabulary.
        assert set(item["skillTags"]) <= set(part.allowed_skill_tags)


def test_insufficient_context_omits_score_dimensions_rather_than_fabricating(monkeypatch: pytest.MonkeyPatch) -> None:
    """When analyse_writing() can't score the text (too short/vague), no
    dimension score exists to report — examResultItems must be empty, never
    filled with an invented 0."""
    from app.services import german_exam_writing_grading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    monkeypatch.setattr(mod, "analyse_writing", lambda **kwargs: _fake_analysis(
        score={"overall": None, "grammar": None, "vocabulary": None, "structure": None, "style": None, "taskFulfillment": None},
        insufficientContext={"reason": "tooShort", "message": "Too short.", "minWords": 120},
    ))

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    result = mod.grade_writing_submission(
        user_id="u1", profile=profile, part=part, generation_id="gen-1",
        writing_coach_task_type="stellungnahme", text="Zu kurz.",
    )

    assert result["examResultItems"] == []
    assert result["rubric"]["examScoreValue"] is None


def test_invalid_writing_coach_task_type_falls_back_to_freier_text(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import german_exam_writing_grading as mod
    from app.services.german_exam_profiles import get_profile, get_part

    calls = {"kwargs": None}

    def _fake_analyse_writing(**kwargs):
        calls["kwargs"] = kwargs
        return _fake_analysis()

    monkeypatch.setattr(mod, "analyse_writing", _fake_analyse_writing)

    profile = get_profile("telc_c1_hochschule")
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    mod.grade_writing_submission(
        user_id="u1", profile=profile, part=part, generation_id=None,
        writing_coach_task_type="not_a_real_task_type", text="text",
    )

    assert calls["kwargs"]["task_type"] == "freier_text"

from types import SimpleNamespace

from app.services import writing_coach as coach


def test_generic_and_exam_share_evaluator_with_optional_task_context(monkeypatch):
    calls = []
    def chat(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(data={"score": {"overall": 70, "grammar": 80}, "feedbackItems": []},
                               model="stub", prompt_tokens=1, completion_tokens=1)
    monkeypatch.setattr(coach, "chat_json", chat)
    monkeypatch.setattr(coach, "get_settings", lambda: SimpleNamespace(openai_generate_model="stub", openai_generate_model_strong="stub"))
    args = dict(user_id="u", text="Studierende diskutieren über die Universität. " * 40,
                profile_level="C1 Hochschule", task_type="argumentation")
    generic = coach.analyse_writing(**args)
    exam = coach.analyse_writing(**args, exam_context={"selectedTopic": {"title": "Studiengebühren", "taskInstructions": "Erörtern Sie Vor- und Nachteile."}})
    assert generic["score"] == exam["score"]
    assert "EXAM MODE" not in calls[0]["system"]
    assert "EXAM MODE" in calls[1]["system"]
    assert "Studiengebühren" in calls[1]["user"]
    assert "Vor- und Nachteile" in calls[1]["user"]


def test_generic_short_text_still_avoids_llm(monkeypatch):
    monkeypatch.setattr(coach, "chat_json", lambda **kwargs: (_ for _ in ()).throw(AssertionError("LLM must not run")))
    result = coach.analyse_writing(user_id="u", text="Zu kurz.", profile_level="B2", task_type="freier_text")
    assert result["insufficientContext"]["reason"] == "tooShort"
    assert result["score"]["overall"] is None

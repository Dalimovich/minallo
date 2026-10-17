from app.services.web_answer import _SYSTEM_PROMPT


def test_web_answer_prompt_requires_matching_the_question_language() -> None:
    assert "language of the student's latest message" in _SYSTEM_PROMPT

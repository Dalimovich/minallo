from app.services.general_answer import _SYSTEM_PROMPT
from app.services.source_router import auto_general_prefix


def test_auto_general_routing_does_not_leak_into_answer_text() -> None:
    assert auto_general_prefix() == ""
    assert "does not seem to depend on your uploaded files" not in auto_general_prefix()


def test_general_prompt_requires_action_and_conversation_continuity() -> None:
    prompt = _SYSTEM_PROMPT.casefold()
    assert "perform that task" in prompt
    assert "follow the conversation naturally" in prompt
    assert "never\nnarrate source routing" in prompt
    assert "learning plan" not in prompt

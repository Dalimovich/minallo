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


# ── Phase 6 of the TTFT brief: a plain conversational answer is not math
# ── work, so a reasoning-model OPENAI_GENERATE_MODEL must use "low"
# ── reasoning effort here too, same as notes_full.py's synthesis calls —
# ── not the global (math-tuned) default, which would make every general-
# ── knowledge/fast-lane answer as slow as a deep math call.

def _fake_settings(**overrides):
    from types import SimpleNamespace
    defaults = {"openai_generate_model": "gpt-5-mini", "openai_reasoning_effort": "high"}
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_generate_general_answer_uses_low_reasoning_effort_for_a_reasoning_model(monkeypatch) -> None:
    from app.services import general_answer

    captured_kwargs: dict = {}

    class _FakeMessage:
        content = "An answer."

    class _FakeChoice:
        message = _FakeMessage()

    class _FakeResponse:
        choices = [_FakeChoice()]
        usage = None

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_kwargs.update(kwargs)
                    return _FakeResponse()

    monkeypatch.setattr(general_answer, "get_settings", lambda: _fake_settings())
    monkeypatch.setattr(general_answer, "get_openai_client", lambda: _FakeClient())

    general_answer.generate_general_answer("What is torque?")

    assert captured_kwargs.get("reasoning_effort") == "low"
    assert captured_kwargs.get("max_completion_tokens") == 12000


def test_stream_general_answer_uses_low_reasoning_effort_for_a_reasoning_model(monkeypatch) -> None:
    from app.services import general_answer

    captured_kwargs: dict = {}

    class _FakeStream:
        def __iter__(self):
            return iter([])

    class _FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_kwargs.update(kwargs)
                    return _FakeStream()

    monkeypatch.setattr(general_answer, "get_settings", lambda: _fake_settings())
    monkeypatch.setattr(general_answer, "get_openai_client", lambda: _FakeClient())

    list(general_answer.stream_general_answer("What is torque?"))

    assert captured_kwargs.get("reasoning_effort") == "low"
    assert captured_kwargs.get("max_completion_tokens") == 12000

from app.services.general_answer import _SYSTEM_PROMPT, generate_general_answer
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


def test_general_prompt_requires_matching_the_question_language() -> None:
    assert "language of the student's latest message" in _SYSTEM_PROMPT


def test_general_prompt_states_support_reactions_correctly() -> None:
    prompt = " ".join(_SYSTEM_PROMPT.split())
    assert "Festlager (pin support) carries a horizontal AND a vertical force but NO moment" in prompt
    assert "Loslager" in prompt and "Einspannung" in prompt


class _FakeCompletions:
    def __init__(self) -> None:
        self.captured_messages: list[dict[str, str]] = []

    def create(self, **kwargs):
        self.captured_messages = kwargs["messages"]
        message = type("M", (), {"content": "Answer"})()
        choice = type("C", (), {"message": message})()
        return type("R", (), {"choices": [choice], "usage": None})()


class _FakeClient:
    def __init__(self) -> None:
        self.chat = type("Chat", (), {"completions": _FakeCompletions()})()


def test_generate_general_answer_sends_context_block_and_history(monkeypatch) -> None:
    from app.services import general_answer as ga

    client = _FakeClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: client)

    generate_general_answer(
        "Wie ist die DSH-Prüfung aufgebaut?",
        previous_turns=[
            {"role": "user", "text": "Ich lerne für die DSH."},
            {"role": "assistant", "text": "Viel Erfolg!"},
        ],
        context_block="\n\nGERMAN LEARNER PROFILE\n- Target level: DSH-2",
    )

    messages = client.chat.completions.captured_messages
    assert "GERMAN LEARNER PROFILE" in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "Ich lerne für die DSH."}
    assert messages[2] == {"role": "assistant", "content": "Viel Erfolg!"}
    assert messages[-1]["content"] == "Wie ist die DSH-Prüfung aufgebaut?"


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

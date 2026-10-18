from app.services import general_answer as ga
from app.services.dialogue_state import resolve_dialogue
from app.services.general_answer import _SYSTEM_PROMPT, generate_general_answer, stream_general_answer
from app.services.grounding_contract import ResolvedDocumentAccess
from app.services.source_router import auto_general_prefix
from app.services.student_intent import interpret_student_intent


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


# ── PR3: StudentIntent-driven answer constraints reach the actual outgoing
# ── messages on this path (which, unlike answer.py's grounded path, never
# ── called intent_style_instruction at all before this PR — confirmed gap).


def _enabled_intent(message: str):
    """A real StudentIntent, deterministic-only (mode="enabled" but no
    model call needed for these messages), via the same adapter the
    production router uses — not a hand-built dataclass, so the
    AnswerConstraints fields actually reflect the message text."""
    dialogue = resolve_dialogue(message, previous_turns=[])
    return interpret_student_intent(
        message, dialogue=dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        mode="enabled",
    )


def test_general_answer_applies_no_summary_prohibition(monkeypatch) -> None:
    """general_answer.py never called explicit_prohibition_lines/intent_
    style_instruction before this PR — verify the actual outgoing system
    message now carries the no-summary instruction."""
    client = _FakeClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: client)

    question = "Explain the concept in detail. Do not summarize it."
    generate_general_answer(question)

    system_message = client.chat.completions.captured_messages[0]["content"]
    assert "Do NOT include a" in system_message
    assert "Summary" in system_message


def test_general_answer_applies_student_intent_constraints(monkeypatch) -> None:
    client = _FakeClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: client)

    question = "Quiz me on thermodynamics but do not show me the answers yet."
    intent = _enabled_intent(question)
    assert intent.answer_constraints.withhold_answer is True

    generate_general_answer(question, student_intent=intent)

    messages = client.chat.completions.captured_messages
    assert "Do NOT reveal the correct answer" in messages[0]["content"]
    assert "Do NOT reveal the correct answer" in messages[-1]["content"]


def test_general_answer_student_intent_none_matches_omitted_param(monkeypatch) -> None:
    """off/shadow pass student_intent=None explicitly — must be byte-
    identical to a caller that never passes the parameter at all."""
    client_a = _FakeClient()
    client_b = _FakeClient()

    question = "What is the formula for torsion?"
    monkeypatch.setattr(ga, "get_openai_client", lambda: client_a)
    generate_general_answer(question)
    monkeypatch.setattr(ga, "get_openai_client", lambda: client_b)
    generate_general_answer(question, student_intent=None)

    assert client_a.chat.completions.captured_messages == client_b.chat.completions.captured_messages


def test_stream_general_answer_applies_hint_only_constraint(monkeypatch) -> None:
    captured_kwargs: dict = {}

    class _FakeStream:
        def __iter__(self):
            return iter([])

    class _FakeStreamClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    captured_kwargs.update(kwargs)
                    return _FakeStream()

    monkeypatch.setattr(ga, "get_openai_client", lambda: _FakeStreamClient())

    question = "Can I get a hint, not the full solution?"
    intent = _enabled_intent(question)
    assert intent.answer_constraints.hint_only is True

    list(stream_general_answer(question, student_intent=intent))

    messages = captured_kwargs["messages"]
    assert "Give a hint only" in messages[0]["content"]
    assert "Give a hint only" in messages[-1]["content"]

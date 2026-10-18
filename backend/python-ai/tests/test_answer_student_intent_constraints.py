"""PR3: validated StudentIntent answer constraints must reach the actual
outgoing model messages on the grounded path — both the non-streaming
(answer.py) and streaming (answer_stream.py) call sites. answer.py already
had the no-summary/no-quiz safeguard via pick_system_prompt/intent_style_
instruction; these tests focus on the NEW overlay and its off/shadow
parity guarantee, verified at the real message boundary.
"""

from unittest.mock import MagicMock

from app.services.dialogue_state import resolve_dialogue
from app.services.grounding_contract import ResolvedDocumentAccess
from app.services.student_intent import interpret_student_intent


def _enabled_intent(message: str):
    dialogue = resolve_dialogue(message, previous_turns=[])
    return interpret_student_intent(
        message, dialogue=dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        mode="enabled",
    )


# ── generate_answer (non-streaming grounded path) ──────────────────────────


class _FakeCompletions:
    def __init__(self) -> None:
        self.captured_kwargs: dict = {}

    def create(self, **kwargs):
        self.captured_kwargs = kwargs
        message = type("M", (), {"content": "An answer."})()
        choice = type("C", (), {"message": message})()
        return type("R", (), {"choices": [choice], "usage": None})()


class _FakeClient:
    def __init__(self) -> None:
        self.chat = type("Chat", (), {"completions": _FakeCompletions()})()


def test_generate_answer_applies_student_intent_constraints(monkeypatch) -> None:
    from app.services import answer as answer_module

    client = _FakeClient()
    monkeypatch.setattr(answer_module, "get_openai_client", lambda: client)

    question = "Quiz me on thermodynamics but do not show me the answers yet."
    intent = _enabled_intent(question)
    assert intent.answer_constraints.withhold_answer is True

    answer_module.generate_answer(
        question=question, chunks=[], doc_names={}, student_intent=intent,
    )

    messages = client.chat.completions.captured_kwargs["messages"]
    system_message = next(m["content"] for m in messages if m["role"] == "system")
    user_message = next(m["content"] for m in messages if m["role"] == "user")
    assert "Do NOT reveal the correct answer" in system_message
    assert "Do NOT reveal the correct answer" in user_message


def test_generate_answer_student_intent_none_matches_omitted_param(monkeypatch) -> None:
    from app.services import answer as answer_module

    client_a, client_b = _FakeClient(), _FakeClient()
    question = "Explain Newton's third law."

    monkeypatch.setattr(answer_module, "get_openai_client", lambda: client_a)
    answer_module.generate_answer(question=question, chunks=[], doc_names={})
    monkeypatch.setattr(answer_module, "get_openai_client", lambda: client_b)
    answer_module.generate_answer(question=question, chunks=[], doc_names={}, student_intent=None)

    assert client_a.chat.completions.captured_kwargs["messages"] == \
        client_b.chat.completions.captured_kwargs["messages"]


# ── stream_answer (streaming grounded path) ─────────────────────────────────


class _FakeUsage:
    def __init__(self) -> None:
        self.prompt_tokens = 5
        self.completion_tokens = 2
        self.prompt_tokens_details = None


class _FakeStreamChunk:
    def __init__(self, text=None, usage=None) -> None:
        delta = MagicMock()
        delta.content = text
        choice = MagicMock()
        choice.delta = delta
        self.choices = [choice] if text is not None else []
        self.usage = usage


def _run_stream_answer(monkeypatch, question: str, student_intent=None):
    import app.services.answer_stream as answer_stream_module

    captured: dict = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        return iter([
            _FakeStreamChunk("An "), _FakeStreamChunk("answer."),
            _FakeStreamChunk(None, usage=_FakeUsage()),
        ])

    fake_client = MagicMock()
    fake_client.chat.completions.create.side_effect = fake_create
    monkeypatch.setattr(answer_stream_module, "get_openai_client", lambda: fake_client)

    list(answer_stream_module.stream_answer(
        question=question, chunks=[], doc_names={}, student_intent=student_intent,
    ))
    return captured["messages"]


def test_stream_answer_applies_no_summary_prohibition(monkeypatch) -> None:
    """stream_answer never called intent_style_instruction/explicit_
    prohibition_lines at all before this PR (confirmed gap) — verify the
    actual outgoing system message now carries the no-summary instruction."""
    messages = _run_stream_answer(
        monkeypatch, "Explain the concept in detail. Do not summarize it.",
    )
    system_message = next(m["content"] for m in messages if m["role"] == "system")
    assert "Do NOT include a" in system_message
    assert "Summary" in system_message


def test_stream_answer_applies_student_intent_constraints(monkeypatch) -> None:
    question = "Can I get a hint, not the full solution?"
    dialogue = resolve_dialogue(question, previous_turns=[])
    intent = interpret_student_intent(
        question, dialogue=dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        mode="enabled",
    )
    assert intent.answer_constraints.hint_only is True

    messages = _run_stream_answer(monkeypatch, question, student_intent=intent)
    system_message = next(m["content"] for m in messages if m["role"] == "system")
    user_message = next(m["content"] for m in messages if m["role"] == "user")
    assert "Give a hint only" in system_message
    assert "Give a hint only" in user_message


def test_stream_answer_student_intent_none_matches_omitted_param(monkeypatch) -> None:
    question = "Compare torsion and bending stress."
    messages_omitted = _run_stream_answer(monkeypatch, question)
    messages_none = _run_stream_answer(monkeypatch, question, student_intent=None)
    assert messages_omitted == messages_none

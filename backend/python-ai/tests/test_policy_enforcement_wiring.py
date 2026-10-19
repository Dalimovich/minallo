"""Semantic Student Intent Layer Phase C — proves execution_policy
threads into the real generation call sites: execution_policy=None
(every existing caller, the default) produces byte-identical prompts to
omitting the parameter entirely, and a real compiled policy's rendered
overlay actually reaches the system prompt the model sees."""

from app.services.policy_compiler import ExecutionPolicy
from app.services.resolved_student_intent import Action, ReleaseConstraints


def _policy() -> ExecutionPolicy:
    return ExecutionPolicy(
        actions=(Action(objective="hint", target="5b", release=ReleaseConstraints(form="hint", final_answer="prohibited")),),
        evidence_requirements=(), needs_clarification=False, clarification_question=None,
        response_language="en", response_language_reason="default", platform_policy_applied=(),
        policy_version="1.0.0", compiler_version="1.0.0", policy_hash="deadbeef",
    )


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


def _system_prompt(messages: list[dict[str, str]]) -> str:
    return next(m["content"] for m in messages if m["role"] == "system")


def test_generate_general_answer_none_policy_is_byte_identical(monkeypatch) -> None:
    from app.services import general_answer as ga

    fake = _FakeClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: fake)
    ga.generate_general_answer("What is torsion?")
    without_param = _system_prompt(fake.chat.completions.captured_messages)

    fake2 = _FakeClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: fake2)
    ga.generate_general_answer("What is torsion?", execution_policy=None)
    with_none = _system_prompt(fake2.chat.completions.captured_messages)

    assert without_param == with_none


def test_generate_general_answer_real_policy_overlay_reaches_prompt(monkeypatch) -> None:
    from app.services import general_answer as ga

    fake = _FakeClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: fake)
    ga.generate_general_answer("What is torsion?", execution_policy=_policy())
    prompt = _system_prompt(fake.chat.completions.captured_messages)

    assert "STUDENT-REQUESTED ANSWER CONSTRAINTS" in prompt
    assert '"5b"' in prompt
    assert "HINT only" in prompt


def test_stream_general_answer_real_policy_overlay_reaches_prompt(monkeypatch) -> None:
    from app.services import general_answer as ga

    class _FakeStreamCompletions:
        def __init__(self) -> None:
            self.captured_messages: list[dict[str, str]] = []

        def create(self, **kwargs):
            self.captured_messages = kwargs["messages"]
            return iter([])  # no deltas needed for this prompt-assembly check

    class _FakeStreamClient:
        def __init__(self) -> None:
            self.chat = type("Chat", (), {"completions": _FakeStreamCompletions()})()

    fake = _FakeStreamClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: fake)
    list(ga.stream_general_answer("What is torsion?", execution_policy=_policy()))
    prompt = _system_prompt(fake.chat.completions.captured_messages)

    assert "STUDENT-REQUESTED ANSWER CONSTRAINTS" in prompt
    assert "HINT only" in prompt


def test_stream_general_answer_none_policy_is_byte_identical(monkeypatch) -> None:
    from app.services import general_answer as ga

    class _FakeStreamCompletions:
        def __init__(self) -> None:
            self.captured_messages: list[dict[str, str]] = []

        def create(self, **kwargs):
            self.captured_messages = kwargs["messages"]
            return iter([])

    class _FakeStreamClient:
        def __init__(self) -> None:
            self.chat = type("Chat", (), {"completions": _FakeStreamCompletions()})()

    fake1 = _FakeStreamClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: fake1)
    list(ga.stream_general_answer("What is torsion?"))
    without_param = _system_prompt(fake1.chat.completions.captured_messages)

    fake2 = _FakeStreamClient()
    monkeypatch.setattr(ga, "get_openai_client", lambda: fake2)
    list(ga.stream_general_answer("What is torsion?", execution_policy=None))
    with_none = _system_prompt(fake2.chat.completions.captured_messages)

    assert without_param == with_none

"""PR3: visual_repair.py rebuilds a single-message prompt from scratch for
both repair paths, with no system message at all — before this PR, neither
the existing no-summary/no-quiz safeguard nor any StudentIntent overlay
reached either one. These tests mock the OpenAI client boundary and assert
on the actual outgoing prompt text, not just whether a helper was called.
"""

from app.services.dialogue_state import resolve_dialogue
from app.services.grounding_contract import ResolvedDocumentAccess
from app.services.student_intent import interpret_student_intent
from app.services.visual_repair import generate_grounded_repair_sync, repair_false_visual_denial_sync


def _enabled_intent(message: str):
    dialogue = resolve_dialogue(message, previous_turns=[])
    return interpret_student_intent(
        message, dialogue=dialogue, resolved_access=ResolvedDocumentAccess.RELEVANCE,
        mode="enabled",
    )


class _FakeResponse:
    def __init__(self, text: str) -> None:
        message = type("M", (), {"content": text})()
        choice = type("C", (), {"message": message})()
        self.choices = [choice]


class _FakeCompletions:
    def __init__(self) -> None:
        self.captured_kwargs: dict = {}

    def create(self, **kwargs):
        self.captured_kwargs = kwargs
        return _FakeResponse("Repaired answer.")


class _FakeClient:
    def __init__(self) -> None:
        self.chat = type("Chat", (), {"completions": _FakeCompletions()})()


def _captured_prompt(fake_client: _FakeClient) -> str:
    messages = fake_client.chat.completions.captured_kwargs["messages"]
    content = messages[0]["content"]
    # generate_visual_repair always sends content as a list of parts; the
    # first part is always the {"type": "text", "text": prompt} block.
    return next(p["text"] for p in content if p.get("type") == "text")


def test_grounded_repair_applies_no_summary_prohibition(monkeypatch) -> None:
    from app.services import visual_repair as vr

    client = _FakeClient()
    monkeypatch.setattr(vr, "get_openai_client", lambda: client)

    question = "Explain the figure in detail. Do not summarize it."
    generate_grounded_repair_sync(
        request_id="r1", question=question, incorrect_draft="wrong",
        source_context="evidence", image_parts=[], mismatch_codes=["x"],
    )

    prompt = _captured_prompt(client)
    assert "Do NOT include a" in prompt
    assert "Summary" in prompt


def test_grounded_repair_applies_student_intent_constraints(monkeypatch) -> None:
    from app.services import visual_repair as vr

    client = _FakeClient()
    monkeypatch.setattr(vr, "get_openai_client", lambda: client)

    question = "Quiz me on thermodynamics but do not show me the answers yet."
    intent = _enabled_intent(question)
    assert intent.answer_constraints.withhold_answer is True

    generate_grounded_repair_sync(
        request_id="r2", question=question, incorrect_draft="wrong",
        source_context="evidence", image_parts=[], mismatch_codes=["x"],
        student_intent=intent,
    )

    prompt = _captured_prompt(client)
    assert "Do NOT reveal the correct answer" in prompt


def test_grounded_repair_student_intent_none_matches_omitted_param(monkeypatch) -> None:
    from app.services import visual_repair as vr

    client_a, client_b = _FakeClient(), _FakeClient()
    question = "Explain the figure."
    kwargs = dict(
        request_id="r3", question=question, incorrect_draft="wrong",
        source_context="evidence", image_parts=[], mismatch_codes=["x"],
    )

    monkeypatch.setattr(vr, "get_openai_client", lambda: client_a)
    generate_grounded_repair_sync(**kwargs)
    monkeypatch.setattr(vr, "get_openai_client", lambda: client_b)
    generate_grounded_repair_sync(**kwargs, student_intent=None)

    assert _captured_prompt(client_a) == _captured_prompt(client_b)


def test_repair_false_visual_denial_sync_applies_hint_only_constraint(monkeypatch) -> None:
    from app.services import visual_repair as vr

    client = _FakeClient()
    monkeypatch.setattr(vr, "get_openai_client", lambda: client)

    question = "Can I get a hint, not the full solution?"
    intent = _enabled_intent(question)
    assert intent.answer_constraints.hint_only is True

    repair_false_visual_denial_sync(
        request_id="r4", question=question, draft="previous draft",
        visible_page=3, open_context="page text", image_parts=[],
        student_intent=intent,
    )

    prompt = _captured_prompt(client)
    assert "Give a hint only" in prompt

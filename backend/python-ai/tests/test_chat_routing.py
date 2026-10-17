"""Generic chatbot model routing: gpt-4o only for images/diagrams, mini for plain text."""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")
os.environ.setdefault("INTERNAL_SECRET", "stub")

from app.services import chat as ch  # noqa: E402


class _Msg:
    content = "hello"


class _Choice:
    message = _Msg()


class _Resp:
    choices = [_Choice()]


class _FakeCompletions:
    def __init__(self, rec):
        self._rec = rec

    def create(self, **kwargs):
        self._rec["model"] = kwargs.get("model")
        self._rec["messages"] = kwargs.get("messages")
        return _Resp()


class _FakeChat:
    def __init__(self, rec):
        self.completions = _FakeCompletions(rec)


class _FakeClient:
    def __init__(self, rec):
        self.chat = _FakeChat(rec)


def _run(monkeypatch, payload):
    rec: dict = {}
    monkeypatch.setattr(ch, "get_openai_client", lambda: _FakeClient(rec))
    ch.run_chat(payload)
    return rec


def test_plain_text_chat_uses_mini(monkeypatch):
    model = _run(monkeypatch, {"messages": [{"role": "user", "content": "what is a derivative?"}]})["model"]
    assert model == ch.get_settings().openai_generate_model  # gpt-4o-mini
    assert model != "gpt-4o"


def test_image_chat_uses_gpt4o(monkeypatch):
    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what does this show?"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}},
                ],
            }
        ]
    }
    assert _run(monkeypatch, payload)["model"] == "gpt-4o"


def test_server_appends_language_and_statics_rules_even_without_a_client_system_prompt(monkeypatch):
    from app.services.answer import LANGUAGE_MATCH_RULE, STATICS_SUPPORT_RULE

    messages = _run(monkeypatch, {"messages": [{"role": "user", "content": "Wie ist die DSH-Prüfung aufgebaut?"}]})["messages"]
    assert messages[0]["role"] == "system"
    assert LANGUAGE_MATCH_RULE in messages[0]["content"]
    assert STATICS_SUPPORT_RULE in messages[0]["content"]


def test_server_rules_cannot_be_drowned_out_by_the_client_language_override(monkeypatch):
    """The client's buildSystemPrompt() used to send an unconditional "Always
    reply in English" — even with a stale/cached client still sending that,
    the server-appended LANGUAGE_MATCH_RULE must still reach the model."""
    from app.services.answer import LANGUAGE_MATCH_RULE

    payload = {
        "system": "You are Minallo AI. Always reply in English. Answer any question clearly and helpfully.",
        "messages": [{"role": "user", "content": "Wie ist die DSH-Prüfung aufgebaut?"}],
    }
    messages = _run(monkeypatch, payload)["messages"]
    assert messages[0]["role"] == "system"
    assert "Always reply in English" in messages[0]["content"]
    assert LANGUAGE_MATCH_RULE in messages[0]["content"]


def test_has_image_helper():
    assert ch._has_image([{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}])
    assert not ch._has_image([{"role": "user", "content": "plain text"}])

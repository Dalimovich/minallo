"""Unit tests for Deep Learn (Learning Agent Phase 5)."""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import deep_learn as dl  # noqa: E402


class _FakeChatResult:
    def __init__(self, data):
        self.data = data
        self.model = "fake-model"
        self.prompt_tokens = 7
        self.completion_tokens = 70


def test_sources_indexed_for_clickability():
    chunks = [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 3, "pageEnd": 3},
        {"chunkId": "c2", "documentId": "d2", "pageStart": 5, "pageEnd": 6},
    ]
    out = dl._sources(chunks, {"d1": "A.pdf", "d2": "B.pdf"})
    assert [s["index"] for s in out] == [1, 2]
    assert out[0]["fileName"] == "A.pdf"
    assert out[1]["pageStart"] == 5


def test_generate_deep_learn_structured(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 4, "text": "Friction opposes motion."},
    ])
    monkeypatch.setattr(dl, "chat_json", lambda **k: _FakeChatResult({
        "title": "Friction",
        "lesson": "## Idea\nFriction opposes motion (Mech.pdf, p.4)",
        "workedExample": "Block on incline …",
        "check": {"question": "What does friction oppose?", "answer": "Relative motion", "explanation": "By definition"},
    }))

    out = dl.generate_deep_learn(
        user_id="u", course_id="c", topic="Friction", document_ids=["d1"],
        doc_names={"d1": "Mech.pdf"},
    )
    assert out["title"] == "Friction"
    assert "Friction" in out["lesson"]
    assert out["workedExample"]
    assert out["check"]["answer"] == "Relative motion"
    assert out["groundedSources"][0]["fileName"] == "Mech.pdf"
    assert out["groundedSources"][0]["index"] == 1


def test_generate_deep_learn_no_evidence_warns(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [])
    called = {"chat": 0}
    monkeypatch.setattr(dl, "chat_json", lambda **k: called.__setitem__("chat", called["chat"] + 1))
    out = dl.generate_deep_learn(
        user_id="u", course_id="c", topic="Nonexistent", document_ids=None, doc_names={},
    )
    assert out["warning"]
    assert out["lesson"] == ""
    assert out["check"] is None
    assert called["chat"] == 0  # no LLM call without evidence


def test_generate_deep_learn_requires_topic():
    out = dl.generate_deep_learn(user_id="u", course_id="c", topic="  ", document_ids=None, doc_names={})
    assert out["error"]


def test_generate_deep_learn_drops_empty_check(monkeypatch):
    monkeypatch.setattr(dl, "retrieve_learning_context", lambda **k: [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 1, "text": "x"},
    ])
    monkeypatch.setattr(dl, "chat_json", lambda **k: _FakeChatResult({
        "title": "T", "lesson": "L", "workedExample": "", "check": {"question": "  "},
    }))
    out = dl.generate_deep_learn(
        user_id="u", course_id="c", topic="T", document_ids=None, doc_names={"d1": "a.pdf"},
    )
    assert out["check"] is None

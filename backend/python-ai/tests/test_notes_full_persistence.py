"""Regression coverage for the Notes "generate"/"merge" persistence contract:
a caller must never be able to infer a note was saved from content_markdown
alone. _save_note() silently returns None on any DB failure (RLS violation,
network error, ...), and until this fix both response builders shipped that
None id straight back to the client as if nothing had gone wrong.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings  # noqa: WPS433

    get_settings.cache_clear()


class _FakeInsertResult:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    """Records every insert; execute() can be told to simulate a failed
    (empty-data) write, matching what a caught RLS/DB exception produces."""

    def __init__(self, succeed: bool):
        self.succeed = succeed
        self.insert_calls: list[dict] = []

    def insert(self, payload):
        self.insert_calls.append(payload)
        return self

    def execute(self):
        if not self.succeed:
            return _FakeInsertResult([])
        return _FakeInsertResult([{"id": "note-123"}])


class _FakeSupabase:
    def __init__(self, notes_table: _FakeTable):
        self._notes_table = notes_table

    def table(self, name):
        # note_sources is only touched when note_id + document_id + sources
        # are all present, which isn't exercised by these tests.
        return self._notes_table


def _payload(**overrides):
    from app.routers.notes_full import NotesGenerateRequest

    base = dict(
        userId="11111111-1111-1111-1111-111111111111",
        courseId="22222222-2222-2222-2222-222222222222",
        documentId=None,
        tool="notes",
        mode="generate",
        scope="document",
        fileName="Zusammenfassung_ME_3_Getriebe.pdf",
        pdfText="Getriebe " * 40,  # > 100 chars so the pdfText fallback context is used
        language="de",
    )
    base.update(overrides)
    return NotesGenerateRequest(**base)


def _stub_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import notes_full

    monkeypatch.setattr(
        notes_full, "_call_openai",
        lambda system_prompt, user_message, max_tokens=4000, user_id=None, heavy=False: (
            "# Getriebe\n\nGenerated notes body.", False
        ),
    )


def test_a_successful_db_insert_returns_a_real_note_id(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    fake_table = _FakeTable(succeed=True)
    monkeypatch.setattr(notes_full, "get_supabase", lambda: _FakeSupabase(fake_table))

    result = notes_full.notes_generate(_payload())

    assert result["note"]["id"] == "note-123"
    assert result["note"]["content_markdown"]
    assert "error" not in result


def test_a_failed_db_insert_never_reports_success(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    fake_table = _FakeTable(succeed=False)
    monkeypatch.setattr(notes_full, "get_supabase", lambda: _FakeSupabase(fake_table))

    result = notes_full.notes_generate(_payload())

    # Generation itself succeeded (content is present)...
    assert result["note"]["content_markdown"]
    # ...but persistence did not, and the response must say so explicitly —
    # a caller checking only content_markdown must not be able to conclude
    # the note was saved.
    assert result["note"]["id"] is None
    assert result.get("error") == "persist_failed"


def test_merge_mode_also_reports_a_failed_db_insert(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    fake_table = _FakeTable(succeed=False)
    monkeypatch.setattr(notes_full, "get_supabase", lambda: _FakeSupabase(fake_table))

    payload = _payload(
        mode="merge",
        sections=[{"pageStart": 1, "pageEnd": 2, "title": "Intro", "markdown": "Body one."}],
    )
    result = notes_full.notes_generate(payload)

    assert result["note"]["content_markdown"]
    assert result["note"]["id"] is None
    assert result.get("error") == "persist_failed"

"""Regression coverage for the Notes "generate" long-document behavior.

Two source paths exist:
  - an indexed documentId -> _fetch_chunks() has no page cap at all;
  - a raw pdfText fallback (no index yet) -> capped at _MAX_CONTEXT_CHARS to
    fit one LLM call.

The frontend's old 20-page hardcoded extraction cap meant the pdfText
fallback almost never carried a document's full content in the first place;
the frontend fix removes that cap (extracts every page pdf.js can read).
But even with the full text now reaching this endpoint, _MAX_CONTEXT_CHARS
can still slice it — and until this fix, that slice was completely silent.
These tests prove it is no longer silent: a truncated pdfText source is
flagged (`sourceTruncated`) and the persisted/returned content explicitly
says so.
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
    def __init__(self):
        self.insert_calls: list[dict] = []

    def insert(self, payload):
        self.insert_calls.append(payload)
        return self

    def execute(self):
        return _FakeInsertResult([{"id": "note-123"}])


class _FakeSupabase:
    def __init__(self, notes_table: _FakeTable):
        self._notes_table = notes_table

    def table(self, name):
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
        pdfText="Getriebe " * 40,
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


def _fake_table_deps(monkeypatch: pytest.MonkeyPatch):
    from app.routers import notes_full

    fake_table = _FakeTable()
    monkeypatch.setattr(notes_full, "get_supabase", lambda: _FakeSupabase(fake_table))
    return fake_table


def test_a_short_document_is_not_flagged_as_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    _fake_table_deps(monkeypatch)

    result = notes_full.notes_generate(_payload(pdfText="Short lecture text. " * 10))

    assert result.get("sourceTruncated") is False
    assert "not fully indexed" not in result["note"]["content_markdown"]


def test_a_long_unindexed_document_is_explicitly_flagged_as_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    _fake_table_deps(monkeypatch)

    # Bigger than _MAX_CONTEXT_CHARS (28_000) — simulates a real multi-page
    # lecture extracted in full by the (now uncapped) frontend extraction.
    long_text = "Page content sentence. " * 3000
    assert len(long_text) > notes_full._MAX_CONTEXT_CHARS

    result = notes_full.notes_generate(_payload(pdfText=long_text))

    # It must still generate something useful from what it could fit...
    assert result["note"]["content_markdown"]
    assert result["note"]["id"] == "note-123"
    # ...but must never silently present a partial extract as if it were
    # complete "whole document" notes.
    assert result.get("sourceTruncated") is True
    assert "not fully indexed" in result["note"]["content_markdown"]


def test_the_persisted_note_also_carries_the_truncation_notice(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reopening the note later (not just the live chat reply) must still
    show the caveat — the notice is baked into what gets saved, not only
    into the one-off response."""
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    fake_table = _fake_table_deps(monkeypatch)

    long_text = "Page content sentence. " * 3000
    notes_full.notes_generate(_payload(pdfText=long_text))

    saved_markdown = fake_table.insert_calls[0]["content_markdown"]
    assert "not fully indexed" in saved_markdown


def test_an_indexed_document_path_is_never_flagged_as_truncated_by_this_mechanism(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """documentId + chunks has its own (uncapped, page-based) coverage —
    _MAX_CONTEXT_CHARS truncation of pdfText must not apply to that path at
    all, since pdfText is ignored whenever real chunks were found."""
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    _fake_table_deps(monkeypatch)
    # Ownership verification is a separate concern from sourceTruncated —
    # stub it out so this test can focus on the chunk-vs-pdfText branch.
    monkeypatch.setattr(notes_full, "_verify_document_owner", lambda *a, **kw: None)
    monkeypatch.setattr(
        notes_full, "_fetch_chunks",
        lambda user_id, course_id, document_id, start, end: [
            {"page_start": 1, "page_end": 1, "chunk_text": "Chunk one content."},
            {"page_start": 2, "page_end": 2, "chunk_text": "Chunk two content."},
        ],
    )

    result = notes_full.notes_generate(_payload(
        documentId="33333333-3333-3333-3333-333333333333",
        pdfText=None,
    ))

    assert result.get("sourceTruncated") is False

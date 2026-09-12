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


def test_a_short_indexed_document_uses_the_single_shot_path_and_is_not_flagged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A short indexed document (well under the 150-chunk fetch cap and the
    28k character budget) is fully covered by a single _fetch_chunks() +
    _build_context() call — no need for the section/merge fan-out."""
    from app.routers import notes_full

    _stub_llm(monkeypatch)
    _fake_table_deps(monkeypatch)
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


def _build_fake_indexed_document(page_count: int, sentinel_page: int, sentinel: str):
    """A synthetic document whose chunks together exceed BOTH the 150-row
    single-fetch cap and the 28,000-char context budget — the exact
    conditions under which the old code would have silently generated
    "whole document" notes from only an early prefix. One page carries a
    unique sentinel string so the test can prove that page's content
    actually reached the final merged/persisted output, not just that no
    error was raised."""
    chunks = []
    for page in range(1, page_count + 1):
        text = f"Filler discussion of course material on page {page}. " * 6
        if page == sentinel_page:
            text += sentinel
        chunks.append({"page_start": page, "page_end": page, "chunk_text": text})
    return chunks


def test_a_long_indexed_document_covers_every_page_via_section_and_merge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """This is the regression test for the actual reported bug: an indexed,
    fully-processed 70+ page lecture must not be silently reduced to an
    early prefix just because a single generate call can't hold it all.
    _call_openai is stubbed to echo its input verbatim, so the sentinel
    planted on a LATE page can only appear in the final persisted content if
    that page's chunk was (a) fetched, (b) sent through section generation,
    and (c) survived the merge step — proving real coverage, not just the
    absence of a `sourceTruncated` flag."""
    from app.routers import notes_full

    page_count = 200
    # Deliberately beyond BOTH old-code failure points: the 150-row single
    # fetch cap (so the old code's unscoped _fetch_chunks call would never
    # even retrieve this chunk) AND the ~28,000-char single-shot budget
    # (which this fixture's chunk sizes exhaust by ~page 90 on its own) —
    # confirmed empirically before picking this page, not guessed.
    sentinel_page = 175
    sentinel = "FINAL_LATE_DOCUMENT_CONCEPT"
    all_chunks = _build_fake_indexed_document(page_count, sentinel_page, sentinel)
    # Sanity check the fixture actually exercises both real limits.
    total_chars = sum(len(c["chunk_text"]) for c in all_chunks)
    assert total_chars > notes_full._MAX_CONTEXT_CHARS
    assert page_count > 150

    monkeypatch.setattr(notes_full, "_verify_document_owner", lambda *a, **kw: None)
    _fake_table_deps(monkeypatch)
    # Echo the prompt back as the "generated" text for both section and merge
    # calls — real section/merge prompting is exercised elsewhere (prompt
    # content tests); this test is purely about which PAGES survive to the
    # final saved note.
    monkeypatch.setattr(
        notes_full, "_call_openai",
        lambda system_prompt, user_message, max_tokens=4000, user_id=None, heavy=False: (user_message, False),
    )
    monkeypatch.setattr(
        notes_full, "_fetch_page_structure",
        lambda user_id, course_id, document_id: [
            {"page_start": c["page_start"], "page_end": c["page_end"], "section_title": None}
            for c in all_chunks
        ],
    )

    def fake_fetch_chunks(user_id, course_id, document_id, page_start, page_end):
        limit = 150 if (page_start is None and page_end is None) else 80
        if page_start is None and page_end is None:
            rows = all_chunks
        else:
            rows = [
                c for c in all_chunks
                if (page_end is None or c["page_start"] <= page_end)
                and (page_start is None or c["page_end"] >= page_start)
            ]
        return rows[:limit]

    monkeypatch.setattr(notes_full, "_fetch_chunks", fake_fetch_chunks)

    result = notes_full.notes_generate(_payload(
        documentId="44444444-4444-4444-4444-444444444444",
        pdfText=None,
        scope="document",
    ))

    content = result["note"]["content_markdown"]
    # The whole point: content from page 75 must be present in the final
    # note, not silently dropped because it fell outside the first
    # 150-chunk fetch / 28k-char single-shot window.
    assert sentinel in content
    # Sanity: content from the very first and very last pages too — full
    # coverage, not just "somewhere in the middle got lucky".
    assert "page 1." in content or "page 1 " in content
    assert f"page {page_count}." in content or f"page {page_count} " in content
    assert result["note"]["id"] == "note-123"
    assert result.get("error") is None
    assert result.get("sourceTruncated") is False

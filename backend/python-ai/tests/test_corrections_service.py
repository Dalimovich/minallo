"""Service tests for the OCR correction / reindex helpers in indexing.py.

Uses a tiny fake Supabase client and stubs the chunk/embed/topic/block
functions so no real OpenAI / Postgres calls happen — the focus is the
orchestration logic (page ordering, gap-filling, chunk_count write, the
[unclear] recount on correction).
"""

from __future__ import annotations

import os
from typing import Any

import pytest

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import indexing  # noqa: E402

_DOC_ID = "11111111-1111-4111-8111-111111111111"


class _Result:
    def __init__(self, data: Any) -> None:
        self.data = data


class _Query:
    def __init__(self, table: str, store: dict) -> None:
        self._table = table
        self._store = store

    def select(self, *a, **k):  # noqa: ANN002
        return self

    def eq(self, *a, **k):  # noqa: ANN002
        return self

    def order(self, *a, **k):  # noqa: ANN002
        return self

    def limit(self, *a, **k):  # noqa: ANN002
        return self

    def update(self, payload):  # noqa: ANN001
        self._store["updates"].append((self._table, payload))
        return self

    def delete(self):
        return self

    def insert(self, rows):  # noqa: ANN001
        self._store["inserts"].append((self._table, rows))
        return self

    def execute(self):
        return _Result(self._store["data"].get(self._table, []))


class _FakeSB:
    def __init__(self, data: dict) -> None:
        self.store = {"data": data, "updates": [], "inserts": []}

    def table(self, name: str) -> _Query:
        return _Query(name, self.store)


@pytest.fixture()
def _stub_pipeline(monkeypatch):
    """Stub the expensive chunk/embed/topic/block functions; capture chunk_pages
    input so tests can assert the reconstructed page order."""
    captured: dict[str, Any] = {}

    class _FakeChunk:
        def __init__(self, text: str) -> None:
            self.chunk_text = text

    def _chunk_pages(page_md):  # noqa: ANN001
        captured["page_md"] = page_md
        return [_FakeChunk("c1"), _FakeChunk("c2")]

    monkeypatch.setattr(indexing, "chunk_pages", _chunk_pages)
    monkeypatch.setattr(indexing, "embed_texts", lambda texts: [[0.0]] * len(texts))
    monkeypatch.setattr(indexing, "extract_topics", lambda **k: ([], [None, None]))
    monkeypatch.setattr(indexing, "detect_exercises", lambda pages_md: [])
    monkeypatch.setattr(indexing, "detect_formulas", lambda pages_md: [])
    monkeypatch.setattr(indexing, "_replace_exercises", lambda *a, **k: {})
    monkeypatch.setattr(indexing, "_replace_formulas", lambda *a, **k: None)
    monkeypatch.setattr(indexing, "_replace_chunks", lambda *a, **k: None)
    return captured


def test_reindex_orders_and_gap_fills_pages(monkeypatch, _stub_pipeline) -> None:
    data = {
        "documents": [{
            "id": _DOC_ID, "user_id": "u", "course_id": "c",
            "source_type": "lecture", "file_name": "notes.pdf",
        }],
        # Deliberately out of order, and missing page 2 (a gap).
        "document_pages": [
            {"page_number": 3, "cleaned_text": "Third page introduces the bending moment diagram and its sign convention."},
            {"page_number": 1, "cleaned_text": "First page covers static equilibrium of a simply supported beam under load."},
        ],
    }
    sb = _FakeSB(data)
    monkeypatch.setattr(indexing, "get_supabase", lambda: sb)

    result = indexing.reindex_chunks_from_pages(_DOC_ID)

    assert result["status"] == "reindexed"
    assert result["chunkCount"] == 2
    # Three page-md entries (max page 3), gap page 2 is empty, order 1..3.
    page_md = _stub_pipeline["page_md"]
    assert [p.page_number for p in page_md] == [1, 2, 3]
    assert "First page" in page_md[0].markdown
    assert page_md[1].markdown == "[unclear]"  # gap page → empty → [unclear]
    assert "Third page" in page_md[2].markdown
    # documents.chunk_count updated.
    doc_updates = [p for (t, p) in sb.store["updates"] if t == "documents"]
    assert doc_updates and doc_updates[-1]["chunk_count"] == 2


def test_correct_document_page_writes_and_recounts_unclear(monkeypatch) -> None:
    data = {"document_pages": [{"page_number": 2}]}  # update().execute() returns truthy
    sb = _FakeSB(data)
    monkeypatch.setattr(indexing, "get_supabase", lambda: sb)

    unclear = indexing.correct_document_page(_DOC_ID, 2, "F = m a [unclear] still [UNCLEAR]")

    assert unclear == 2
    page_updates = [p for (t, p) in sb.store["updates"] if t == "document_pages"]
    assert page_updates, "expected a document_pages update"
    upd = page_updates[-1]
    assert upd["ocr_needs_review"] is False
    assert upd["ocr_unclear_count"] == 2
    assert "F = m a" in upd["cleaned_text"]


def test_correct_document_page_rejects_empty(monkeypatch) -> None:
    sb = _FakeSB({"document_pages": [{"page_number": 1}]})
    monkeypatch.setattr(indexing, "get_supabase", lambda: sb)
    with pytest.raises(indexing.IndexingError):
        indexing.correct_document_page(_DOC_ID, 1, "   ")


def test_correct_document_page_missing_page_raises(monkeypatch) -> None:
    sb = _FakeSB({"document_pages": []})  # update().execute() returns falsy
    monkeypatch.setattr(indexing, "get_supabase", lambda: sb)
    with pytest.raises(indexing.IndexingError):
        indexing.correct_document_page(_DOC_ID, 9, "some text")

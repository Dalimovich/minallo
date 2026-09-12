"""Tests for the Document Understanding backfill (Stage 5)."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import understanding_backfill as bf  # noqa: E402


class _FakeSB:
    """Minimal Supabase stub: documents row + page sample + captured update."""

    def __init__(self, doc_row, pages, chunks=None):
        self._doc = doc_row
        self._pages = pages
        self._chunks = chunks or []
        self.updated: dict | None = None
        self._table = None

    def table(self, name):
        self._table = name
        return self

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def is_(self, *a, **k):
        return self

    def update(self, payload):
        self.updated = payload
        return self

    def execute(self):
        if self._table == "documents":
            data = [self._doc] if self._doc else []
        elif self._table == "document_pages":
            data = self._pages
        elif self._table == "document_chunks":
            data = self._chunks
        else:
            data = []
        return MagicMock(data=data)


def test_backfill_document_recomputes_and_persists():
    sb = _FakeSB(
        doc_row={
            "id": "d1", "file_name": "Klausur_Analysis_2023.pdf",
            "language": "de", "processing_status": "ready",
            "document_understanding": None,
        },
        pages=[
            {"page_number": 1, "cleaned_text":
                "Bearbeitungszeit: 90 Minuten. Aufgabe 1 (10 Punkte). Teilaufgabe a)."},
        ],
        chunks=[{"section_title": "Analysis"}],
    )
    with patch.object(bf, "get_supabase", return_value=sb):
        out = bf.backfill_document("d1")
    assert out["status"] == "updated"
    assert out["documentType"] == "exam"
    assert sb.updated["document_type"] == "exam"
    assert "document_understanding" in sb.updated
    assert sb.updated["document_understanding"]["detected_language"] == "de"


def test_backfill_skips_when_present_and_not_forced():
    sb = _FakeSB(
        doc_row={"id": "d1", "file_name": "x.pdf", "processing_status": "ready",
                 "document_understanding": {"document_type": "lecture"}},
        pages=[],
    )
    with patch.object(bf, "get_supabase", return_value=sb):
        out = bf.backfill_document("d1")
    assert out["status"] == "skipped_present"
    assert sb.updated is None


def test_backfill_skips_not_ready():
    sb = _FakeSB(
        doc_row={"id": "d1", "file_name": "x.pdf", "processing_status": "indexing",
                 "document_understanding": None},
        pages=[],
    )
    with patch.object(bf, "get_supabase", return_value=sb):
        out = bf.backfill_document("d1")
    assert out["status"] == "skipped_not_ready"


def test_backfill_document_not_found():
    sb = _FakeSB(doc_row=None, pages=[])
    with patch.object(bf, "get_supabase", return_value=sb):
        out = bf.backfill_document("missing")
    assert out["status"] == "not_found"

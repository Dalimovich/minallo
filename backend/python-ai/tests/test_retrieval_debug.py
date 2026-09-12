"""Tests for the Phase 2 retrieval-debug helper."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from unittest.mock import MagicMock, patch

# Stub supabase_client before importing the module under test — the local
# venv doesn't ship the `supabase` package.
_fake_sb = types.ModuleType("app.supabase_client")
_fake_sb.get_supabase = lambda: None
sys.modules.setdefault("app.supabase_client", _fake_sb)

from app.services.retrieval_debug import (  # noqa: E402
    DebugPayload,
    chunk_to_meta,
    record_retrieval_debug,
)


@dataclass
class _FakeChunk:
    chunk_id: str
    document_id: str
    page_start: int
    page_end: int
    text: str
    score: float
    similarity: float
    chunk_type: str
    section_title: str | None = None


def test_chunk_to_meta_truncates_long_excerpt() -> None:
    c = _FakeChunk(
        chunk_id="c1", document_id="d1", page_start=1, page_end=1,
        text="x" * 500, score=0.9, similarity=0.8, chunk_type="lecture",
    )
    meta = chunk_to_meta(c)
    assert meta["chunkId"] == "c1"
    assert meta["documentId"] == "d1"
    assert meta["pageStart"] == 1
    assert meta["score"] == 0.9
    assert meta["chunkType"] == "lecture"
    assert len(meta["excerpt"]) <= 200
    assert meta["excerpt"].endswith("…")


def test_chunk_to_meta_normalizes_newlines() -> None:
    c = _FakeChunk(
        chunk_id="c2", document_id="d2", page_start=2, page_end=3,
        text="line1\nline2\nline3", score=0.1, similarity=0.1, chunk_type="exercise",
        section_title="Aufgabe 1.2",
    )
    meta = chunk_to_meta(c)
    assert "\n" not in meta["excerpt"]
    assert meta["sectionTitle"] == "Aufgabe 1.2"


def test_chunk_to_meta_accepts_dict_input() -> None:
    meta = chunk_to_meta({
        "chunkId": "c3", "documentId": "d3", "pageStart": 4, "pageEnd": 4,
        "text": "hello", "score": 0.5, "similarity": 0.5, "chunkType": "formula",
    })
    assert meta["chunkId"] == "c3"
    assert meta["excerpt"] == "hello"


def test_chunk_to_meta_includes_filename_and_synthetic_flag() -> None:
    c = _FakeChunk(
        chunk_id="c4", document_id="d4", page_start=7, page_end=7,
        text="formula text", score=99.0, similarity=1.0, chunk_type="formula",
    )
    c.is_synthetic = True  # type: ignore[attr-defined]

    meta = chunk_to_meta(c, {"d4": "Formelzettel.pdf"})

    assert meta["fileName"] == "Formelzettel.pdf"
    assert meta["synthetic"] is True


def test_record_retrieval_debug_inserts_expected_shape() -> None:
    captured: dict = {}

    def fake_get_supabase():
        client = MagicMock()
        def insert(row):
            captured.update(row)
            return MagicMock(execute=lambda: None)
        client.table.return_value.insert.side_effect = insert
        return client

    with patch("app.services.retrieval_debug.get_supabase", fake_get_supabase):
        record_retrieval_debug(DebugPayload(
            user_id="u1", course_id="c1", endpoint="ask",
            question="What is the bending moment?",
            active_document_id="d-active",
            selected_document_ids=["d1", "d2"],
            retrieval_strategy="vector+bm25",
            retrieval_mode="strong",
            candidate_doc_count=2,
            exercise_hit=None,
            chunks=[_FakeChunk(
                chunk_id="c1", document_id="d1", page_start=1, page_end=1,
                text="t", score=0.7, similarity=0.6, chunk_type="lecture",
            )],
            model="gpt-4o-mini",
            cache_hit=False,
            prompt_tokens=100,
            completion_tokens=200,
            doc_names={"d1": "Lecture.pdf"},
        ))

    assert captured["endpoint"] == "ask"
    assert captured["active_document_id"] == "d-active"
    assert captured["selected_document_ids"] == ["d1", "d2"]
    assert captured["retrieval_mode"] == "strong"
    assert captured["cache_hit"] is False
    assert len(captured["chunk_metadata"]) == 1
    assert captured["chunk_metadata"][0]["chunkId"] == "c1"
    assert captured["chunk_metadata"][0]["fileName"] == "Lecture.pdf"


def test_record_retrieval_debug_stores_exact_hits_when_provided() -> None:
    captured: dict = {}

    def fake_get_supabase():
        client = MagicMock()
        def insert(row):
            captured.update(row)
            return MagicMock(execute=lambda: None)
        client.table.return_value.insert.side_effect = insert
        return client

    exact_hits = {
        "exercise": None,
        "formulas": [{"documentId": "d1", "formulaName": "Hooke", "pageNumber": 3}],
    }

    with patch("app.services.retrieval_debug.get_supabase", fake_get_supabase):
        record_retrieval_debug(DebugPayload(
            user_id="u1", course_id="c1", endpoint="ask",
            question="formula?", active_document_id=None,
            selected_document_ids=None, retrieval_strategy="formula-exact+vector+bm25",
            retrieval_mode="strong", candidate_doc_count=1,
            exercise_hit=None, exact_hits=exact_hits, chunks=[],
        ))

    assert captured["exercise_hit"] == exact_hits


def test_record_retrieval_debug_swallows_db_errors() -> None:
    def fake_get_supabase():
        client = MagicMock()
        client.table.side_effect = RuntimeError("db down")
        return client

    with patch("app.services.retrieval_debug.get_supabase", fake_get_supabase):
        # Must not raise.
        record_retrieval_debug(DebugPayload(
            user_id="u1", course_id="c1", endpoint="ask",
            question="q", active_document_id=None,
            selected_document_ids=None, retrieval_strategy=None,
            retrieval_mode=None, candidate_doc_count=None,
            exercise_hit=None, chunks=[],
        ))


def test_record_retrieval_debug_handles_empty_chunks() -> None:
    captured: dict = {}

    def fake_get_supabase():
        client = MagicMock()
        def insert(row):
            captured.update(row)
            return MagicMock(execute=lambda: None)
        client.table.return_value.insert.side_effect = insert
        return client

    with patch("app.services.retrieval_debug.get_supabase", fake_get_supabase):
        record_retrieval_debug(DebugPayload(
            user_id="u1", course_id="c1", endpoint="ask",
            question="q", active_document_id=None,
            selected_document_ids=None, retrieval_strategy="cache",
            retrieval_mode="strong", candidate_doc_count=None,
            exercise_hit=None, chunks=[], cache_hit=True,
        ))

    assert captured["chunk_metadata"] == []
    assert captured["selected_document_ids"] == []
    assert captured["cache_hit"] is True

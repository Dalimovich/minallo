"""Tests for indexing crash-recovery + concurrency helpers.

Supabase is mocked; these cover the cross-worker claim logic and the
bounded/recovery entrypoints without touching the real pipeline.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import app.services.indexing as indexing


def _mock_sb(stuck_rows, claim_data):
    sb = MagicMock()
    # select(...).in_(...).lt(...).limit(...).execute()
    (
        sb.table.return_value.select.return_value.in_.return_value
        .lt.return_value.limit.return_value.execute.return_value
    ) = MagicMock(data=stuck_rows)
    # update(...).eq(...).lt(...).execute()
    (
        sb.table.return_value.update.return_value.eq.return_value
        .lt.return_value.execute.return_value
    ) = MagicMock(data=claim_data)
    return sb


def test_claim_orphaned_indexing_claims_stuck_docs(monkeypatch):
    stuck = [
        {"id": "d1", "processing_status": "embedding", "updated_at": "2020-01-01T00:00:00Z"},
        {"id": "d2", "processing_status": "chunking", "updated_at": "2020-01-01T00:00:00Z"},
    ]
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb(stuck, claim_data=[{"id": "x"}]))
    assert indexing.claim_orphaned_indexing() == ["d1", "d2"]


def test_claim_orphaned_indexing_skips_when_claim_lost(monkeypatch):
    # The guarded UPDATE matches 0 rows → another worker won the claim.
    stuck = [{"id": "d1", "processing_status": "embedding", "updated_at": "2020-01-01T00:00:00Z"}]
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb(stuck, claim_data=[]))
    assert indexing.claim_orphaned_indexing() == []


def test_claim_orphaned_indexing_empty_when_none_stuck(monkeypatch):
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb([], claim_data=[]))
    assert indexing.claim_orphaned_indexing() == []


def test_run_document_indexing_delegates_under_semaphore(monkeypatch):
    calls = []
    monkeypatch.setattr(
        indexing, "index_document",
        lambda doc_id, *, force: (calls.append((doc_id, force)), {"ok": True})[1],
    )
    out = indexing.run_document_indexing("d1", force=True)
    assert out == {"ok": True}
    assert calls == [("d1", True)]


def test_recover_orphaned_indexing_reindexes_each_claimed(monkeypatch):
    monkeypatch.setattr(indexing, "claim_orphaned_indexing", lambda: ["d1", "d2"])
    seen = []
    monkeypatch.setattr(indexing, "run_document_indexing", lambda doc_id, *, force: seen.append((doc_id, force)))
    assert indexing.recover_orphaned_indexing() == 2
    assert seen == [("d1", True), ("d2", True)]


def test_recover_orphaned_indexing_survives_a_failing_reindex(monkeypatch):
    monkeypatch.setattr(indexing, "claim_orphaned_indexing", lambda: ["d1", "d2"])
    seen = []

    def _boom(doc_id, *, force):
        seen.append(doc_id)
        if doc_id == "d1":
            raise indexing.IndexingError("nope")

    monkeypatch.setattr(indexing, "run_document_indexing", _boom)
    # A failure on d1 must not stop d2 from being attempted.
    assert indexing.recover_orphaned_indexing() == 2
    assert seen == ["d1", "d2"]

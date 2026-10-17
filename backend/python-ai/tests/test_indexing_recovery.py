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


def _mock_sb_idle():
    """A documents row with no in-flight status — _actively_indexing_elsewhere
    must see this as "nothing else running" and let the caller proceed."""
    sb = MagicMock()
    (
        sb.table.return_value.select.return_value.eq.return_value
        .limit.return_value.execute.return_value
    ) = MagicMock(data=[{"processing_status": "ready", "updated_at": "2020-01-01T00:00:00Z"}])
    return sb


def test_run_document_indexing_delegates_under_semaphore(monkeypatch):
    calls = []
    monkeypatch.setattr(
        indexing, "index_document",
        lambda doc_id, *, force: (calls.append((doc_id, force)), {"ok": True})[1],
    )
    monkeypatch.setattr(indexing, "get_supabase", _mock_sb_idle)
    out = indexing.run_document_indexing("d1", force=True)
    assert out == {"ok": True}
    assert calls == [("d1", True)]


def test_recover_orphaned_indexing_reindexes_each_claimed(monkeypatch):
    monkeypatch.setattr(indexing, "claim_orphaned_indexing", lambda: ["d1", "d2"])
    seen = []
    monkeypatch.setattr(
        indexing, "run_document_indexing",
        lambda doc_id, *, force, **kw: seen.append((doc_id, force, kw)),
    )
    assert indexing.recover_orphaned_indexing() == 2
    # The recovery caller must disable the liveness re-check — it already
    # proved staleness itself via claim_orphaned_indexing's atomic claim.
    assert seen == [
        ("d1", True, {"_check_live_elsewhere": False}),
        ("d2", True, {"_check_live_elsewhere": False}),
    ]


def test_recover_orphaned_indexing_survives_a_failing_reindex(monkeypatch):
    monkeypatch.setattr(indexing, "claim_orphaned_indexing", lambda: ["d1", "d2"])
    seen = []

    def _boom(doc_id, *, force, **kw):
        seen.append(doc_id)
        if doc_id == "d1":
            raise indexing.IndexingError("nope")

    monkeypatch.setattr(indexing, "run_document_indexing", _boom)
    # A failure on d1 must not stop d2 from being attempted.
    assert indexing.recover_orphaned_indexing() == 2
    assert seen == ["d1", "d2"]


def test_claim_orphaned_indexing_gives_up_after_max_auto_attempts(monkeypatch):
    # A document already at the attempt cap must be failed outright, not
    # retried forever — the "damaged file loops forever" bug.
    stuck = [{
        "id": "d1", "processing_status": "embedding", "updated_at": "2020-01-01T00:00:00Z",
        "created_at": "2026-10-11T12:00:00Z", "index_attempts": indexing._INDEXING_MAX_AUTO_ATTEMPTS,
    }]
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb(stuck, claim_data=[{"id": "x"}]))
    failed = []
    monkeypatch.setattr(indexing, "_mark_failed", lambda sb, doc_id, reason, **kw: failed.append((doc_id, reason)))
    assert indexing.claim_orphaned_indexing() == []
    assert failed and failed[0][0] == "d1"
    assert "attempts" in failed[0][1]


def test_claim_orphaned_indexing_gives_up_on_very_old_orphans(monkeypatch):
    from datetime import datetime, timedelta, timezone

    too_old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
    stuck = [{
        "id": "d1", "processing_status": "embedding", "updated_at": "2020-01-01T00:00:00Z",
        "created_at": too_old, "index_attempts": 0,
    }]
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb(stuck, claim_data=[{"id": "x"}]))
    failed = []
    monkeypatch.setattr(indexing, "_mark_failed", lambda sb, doc_id, reason, **kw: failed.append((doc_id, reason)))
    assert indexing.claim_orphaned_indexing() == []
    assert failed and failed[0][0] == "d1"
    assert "24h" in failed[0][1]


def test_claim_orphaned_indexing_tolerates_missing_index_attempts_column(monkeypatch):
    # Rows from a DB that hasn't run the 20261011 migration yet simply lack
    # the key — must still claim normally (attempts treated as 0).
    stuck = [{"id": "d1", "processing_status": "embedding", "updated_at": "2020-01-01T00:00:00Z"}]
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb(stuck, claim_data=[{"id": "x"}]))
    assert indexing.claim_orphaned_indexing() == ["d1"]


def test_run_document_indexing_skips_a_duplicate_run_in_this_process(monkeypatch):
    calls = []
    monkeypatch.setattr(indexing, "index_document", lambda doc_id, *, force: calls.append(doc_id))
    monkeypatch.setattr(indexing, "get_index_status", lambda doc_id: {"documentId": doc_id, "status": "indexing"})
    monkeypatch.setattr(indexing, "get_supabase", lambda: MagicMock())
    indexing._in_progress.add("d1")
    try:
        out = indexing.run_document_indexing("d1")
    finally:
        indexing._in_progress.discard("d1")
    assert out == {"documentId": "d1", "status": "indexing"}
    assert calls == []  # index_document was never actually invoked


def _mock_sb_status(processing_status, updated_at):
    sb = MagicMock()
    (
        sb.table.return_value.select.return_value.eq.return_value
        .limit.return_value.execute.return_value
    ) = MagicMock(data=[{"processing_status": processing_status, "updated_at": updated_at}])
    return sb


def test_run_document_indexing_skips_a_duplicate_run_on_another_worker(monkeypatch):
    # Production runs multiple gunicorn workers — the in-process _in_progress
    # set is empty here (simulating a second worker), but the shared
    # documents row shows a genuinely live run (fresh heartbeat).
    from datetime import datetime, timezone

    fresh = datetime.now(timezone.utc).isoformat()
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb_status("embedding", fresh))
    calls = []
    monkeypatch.setattr(indexing, "index_document", lambda doc_id, *, force: calls.append(doc_id))
    monkeypatch.setattr(indexing, "get_index_status", lambda doc_id: {"documentId": doc_id, "status": "indexing"})
    out = indexing.run_document_indexing("d1")
    assert out == {"documentId": "d1", "status": "indexing"}
    assert calls == []


def test_run_document_indexing_proceeds_when_other_worker_status_is_stale(monkeypatch):
    # A status of "embedding" alone isn't enough to block — a dead worker
    # leaves exactly this status behind. Only a FRESH heartbeat counts as live.
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb_status("embedding", "2020-01-01T00:00:00Z"))
    calls = []
    monkeypatch.setattr(
        indexing, "index_document",
        lambda doc_id, *, force: (calls.append(doc_id), {"ok": True})[1],
    )
    out = indexing.run_document_indexing("d1")
    assert out == {"ok": True}
    assert calls == ["d1"]


def test_run_document_indexing_recovery_call_skips_the_liveness_recheck(monkeypatch):
    # claim_orphaned_indexing already stamped updated_at=now as part of its
    # own atomic claim — without _check_live_elsewhere=False, this call would
    # see its own fresh heartbeat and wrongly conclude a duplicate is running.
    from datetime import datetime, timezone

    fresh = datetime.now(timezone.utc).isoformat()
    monkeypatch.setattr(indexing, "get_supabase", lambda: _mock_sb_status("embedding", fresh))
    calls = []
    monkeypatch.setattr(
        indexing, "index_document",
        lambda doc_id, *, force: (calls.append(doc_id), {"ok": True})[1],
    )
    out = indexing.run_document_indexing("d1", force=True, _check_live_elsewhere=False)
    assert out == {"ok": True}
    assert calls == ["d1"]


def test_start_indexing_recovery_sweeper_starts_only_one_thread(monkeypatch):
    started = []
    monkeypatch.setattr(indexing, "_sweeper_started", False)

    class _FakeThread:
        def __init__(self, target, args, name, daemon):
            started.append(name)

        def start(self):
            pass

    monkeypatch.setattr(indexing.threading, "Thread", _FakeThread)
    indexing.start_indexing_recovery_sweeper()
    indexing.start_indexing_recovery_sweeper()
    assert len(started) == 1
    indexing._sweeper_started = False  # restore module state for other tests

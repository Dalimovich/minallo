"""Tests for the generation fan-out bound, query-embedding cache, and the
/internal/metrics snapshot — the Phase-2b concurrency hardening."""

from __future__ import annotations

import threading
import time

import app.services.concurrency as concurrency
import app.services.embeddings as embeddings


# ── Fan-out semaphore ────────────────────────────────────────────────────────

def test_fanout_slot_is_reentrant_release():
    """Acquiring then releasing returns the slot to the pool."""
    before = concurrency.fanout_stats()
    with concurrency.llm_fanout_slot():
        during = concurrency.fanout_stats()
    after = concurrency.fanout_stats()
    assert during["in_use"] == before["in_use"] + 1
    assert after["in_use"] == before["in_use"]
    assert during["limit"] == before["limit"]


def test_fanout_slot_bounds_concurrency(monkeypatch):
    """With the limit pinned to 2, a third concurrent entrant must wait."""
    monkeypatch.setattr(concurrency, "_FANOUT_LIMIT", 2)
    monkeypatch.setattr(concurrency, "_fanout_sem", threading.BoundedSemaphore(2))

    peak = 0
    current = 0
    lock = threading.Lock()
    release = threading.Event()

    def worker():
        nonlocal peak, current
        with concurrency.llm_fanout_slot():
            with lock:
                current += 1
                peak = max(peak, current)
            release.wait(timeout=2)
            with lock:
                current -= 1

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    time.sleep(0.2)
    # At most 2 may be inside the slot at once, regardless of 5 contenders.
    with lock:
        assert peak <= 2
    release.set()
    for t in threads:
        t.join(timeout=2)
    assert concurrency.fanout_stats()["in_use"] == 0


# ── Query-embedding cache ────────────────────────────────────────────────────

def test_embed_query_caches_per_normalised_text(monkeypatch):
    embeddings._embed_query_cached.cache_clear()
    calls = []

    def fake_embed_texts(texts):
        calls.append(list(texts))
        return [[0.1, 0.2, 0.3] for _ in texts]

    monkeypatch.setattr(embeddings, "embed_texts", fake_embed_texts)

    a = embeddings.embed_query("what is a derivative?")
    b = embeddings.embed_query("  what   is a   derivative? ")  # same after normalise
    assert a == [0.1, 0.2, 0.3]
    assert a == b
    # Only ONE underlying embed call despite two queries + whitespace variance.
    assert len(calls) == 1


def test_embed_query_returns_fresh_mutable_list(monkeypatch):
    embeddings._embed_query_cached.cache_clear()
    monkeypatch.setattr(embeddings, "embed_texts", lambda texts: [[1.0, 2.0] for _ in texts])
    first = embeddings.embed_query("q")
    first.append(99.0)  # mutating the returned list must not corrupt the cache
    second = embeddings.embed_query("q")
    assert second == [1.0, 2.0]

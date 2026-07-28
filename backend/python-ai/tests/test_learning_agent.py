"""Unit tests for the Learning Agent Core (Phase 1).

Pure helpers are tested directly; build_course_topic_map / get_next_best_action
use a tiny fake Supabase so no real DB/LLM calls happen.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import learning_agent as la  # noqa: E402


# ── pure helpers ──────────────────────────────────────────────────────────────


def test_purpose_threshold():
    assert la.purpose_threshold("exam_generation") == 0.78
    assert la.purpose_threshold("validation") == 0.85
    assert la.purpose_threshold("unknown-or-none") == 0.70


def test_normalize_topic():
    assert la._normalize_topic("  Circular   Motion ") == "circular motion"
    assert la._normalize_topic("FRICTION") == "friction"


def test_rank_importance():
    assert la._rank_importance(12, 12) == "high"   # ratio 1.0
    assert la._rank_importance(5, 20) == "medium"  # ratio 0.25
    assert la._rank_importance(1, 20) == "low"
    assert la._rank_importance(3, 0) == "medium"   # guard: no max


def test_pages_from_chunk():
    assert la._pages_from_chunk({"page_start": 12, "page_end": 14}) == {12, 13, 14}
    assert la._pages_from_chunk({"page_start": 5, "page_end": None}) == {5}
    assert la._pages_from_chunk({"page_start": None, "page_end": None}) == set()
    # malformed huge range is capped, not exploded
    assert len(la._pages_from_chunk({"page_start": 1, "page_end": 99999})) <= 202


def test_difficulty_from_types():
    from collections import Counter
    assert la._difficulty_from_types(Counter({"formula": 4, "exercise": 4})) == "high"
    assert la._difficulty_from_types(Counter({"text": 9, "formula": 1})) == "low"
    assert la._difficulty_from_types(Counter()) == "medium"


# ── fake Supabase ─────────────────────────────────────────────────────────────


class _Res:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _Q:
    def __init__(self, table, store):
        self.t = table
        self.s = store
        self._count = None

    def select(self, *a, **k):
        self._count = k.get("count")
        return self

    def eq(self, *a, **k):
        return self

    @property
    def not_(self):
        return self

    def is_(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def lt(self, *a, **k):
        return self

    def gte(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def delete(self):
        self.s[self.t] = []
        return self

    def insert(self, rows):
        rows = rows if isinstance(rows, list) else [rows]
        self.s.setdefault(self.t, []).extend(rows)
        return self

    def execute(self):
        rows = self.s.get(self.t, [])
        if self._count == "exact":
            return _Res(list(rows), count=len(rows))
        return _Res(list(rows))


class _SB:
    def __init__(self, store):
        self.s = store

    def table(self, name):
        return _Q(name, self.s)


def test_build_course_topic_map(monkeypatch):
    chunks = [
        {"id": "c1", "document_id": "d1", "primary_topic": "Circular Motion",
         "page_start": 12, "page_end": 13, "chunk_type": "formula", "exercise_id": "e1"},
        {"id": "c2", "document_id": "d1", "primary_topic": "circular motion",
         "page_start": 14, "page_end": 14, "chunk_type": "exercise", "exercise_id": None},
        {"id": "c3", "document_id": "d2", "primary_topic": "Friction",
         "page_start": 1, "page_end": 1, "chunk_type": "text", "exercise_id": None},
    ]
    store = {"document_chunks": chunks}
    monkeypatch.setattr(la, "get_supabase", lambda: _SB(store))

    out = la.build_course_topic_map("u", "c")
    assert len(out) == 2  # the two casings of "circular motion" merged
    cm = next(t for t in out if t["normalized_name"] == "circular motion")
    assert cm["chunk_count"] == 2
    assert cm["importance"] == "high"          # 2/2 of the course
    assert cm["difficulty"] == "high"          # formula+exercise dominate
    assert set(cm["source_pages"]) == {12, 13, 14}
    assert cm["related_exercise_ids"] == ["e1"]
    assert sorted(cm["source_document_ids"]) == ["d1"]


def test_build_topic_map_empty_clears(monkeypatch):
    store = {"document_chunks": [], "course_topics": [{"name": "stale"}]}
    monkeypatch.setattr(la, "get_supabase", lambda: _SB(store))
    out = la.build_course_topic_map("u", "c")
    assert out == []
    assert store["course_topics"] == []  # stale rows cleared


def test_get_next_best_action(monkeypatch):
    topics = [{
        "name": "Circular Motion", "normalized_name": "circular motion",
        "importance": "high", "chunk_count": 5, "source_pages": [],
        "source_document_ids": [], "related_exercise_ids": [],
    }]
    store = {"course_topics": topics}
    monkeypatch.setattr(la, "get_supabase", lambda: _SB(store))
    monkeypatch.setattr(la.mastery, "fetch_weak_topics", lambda u, c: ["Friction"])

    res = la.get_next_best_action("u", "c")
    assert res["weakTopics"] == ["Friction"]
    assert any(a["type"] == "deep_learn" and a["topic"] == "Friction" for a in res["actions"])
    assert any(a["type"] == "examforge" and a["topic"] == "Circular Motion" for a in res["actions"])

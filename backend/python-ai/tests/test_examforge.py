"""Unit tests for ExamForge Phase 3 — blueprint, grounded generation, mastery.

Deterministic helpers are tested directly; generation uses a fake ``chat_json``
and mastery uses a tiny fake Supabase so no real LLM/DB calls happen.
"""

from __future__ import annotations

import os

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("OPENAI_API_KEY", "stub")

from app.services import examforge as ef  # noqa: E402
from app.services import mastery as ms  # noqa: E402


# ── blueprint ─────────────────────────────────────────────────────────────────


def test_build_blueprint_distributes_across_topics_and_types():
    topic_map = [{"name": "Friction"}, {"name": "Circular Motion"}]
    bp = ef._build_blueprint(
        topic_map=topic_map, requested=4, types=["mcq", "short_answer"],
        difficulty="mixed", topic_focus=None,
    )
    assert len(bp) == 4
    # topics cycle through the map
    assert [b["topic"] for b in bp] == ["Friction", "Circular Motion", "Friction", "Circular Motion"]
    # types cycle
    assert [b["question_type"] for b in bp] == ["mcq", "short_answer", "mcq", "short_answer"]
    # mixed difficulty cycles easy/medium/hard
    assert [b["difficulty"] for b in bp] == ["easy", "medium", "hard", "easy"]


def test_build_blueprint_topic_focus_overrides_map():
    bp = ef._build_blueprint(
        topic_map=[{"name": "Friction"}], requested=3, types=["mcq"],
        difficulty="hard", topic_focus="Momentum",
    )
    assert {b["topic"] for b in bp} == {"Momentum"}
    assert {b["difficulty"] for b in bp} == {"hard"}


def test_build_blueprint_empty_map_uses_none_topic():
    bp = ef._build_blueprint(
        topic_map=[], requested=2, types=["mcq"], difficulty="medium", topic_focus=None,
    )
    assert [b["topic"] for b in bp] == [None, None]


# ── grounded generation / local validation ─────────────────────────────────────


class _FakeChatResult:
    def __init__(self, data):
        self.data = data
        self.model = "fake-model"
        self.prompt_tokens = 10
        self.completion_tokens = 20


def test_grounded_questions_flags_grounding(monkeypatch):
    evidence = [
        {"chunkId": "c1", "documentId": "d1", "pageStart": 4, "text": "Friction opposes motion."},
        {"chunkId": "c2", "documentId": "d1", "pageStart": 5, "text": "Static vs kinetic."},
    ]
    # Q1 cites a real chunk → grounded; Q2 cites a chunk not in evidence → ungrounded.
    fake = _FakeChatResult({
        "questions": [
            {"question_type": "mcq", "topic": "Friction", "difficulty": "medium",
             "question": "What does friction do?", "options": ["Opposes", "Helps", "None", "All"],
             "answer": "A", "explanation": "", "source_chunk_ids": ["c1"], "source_pages": [4]},
            {"question_type": "true_false", "topic": "Friction", "difficulty": "easy",
             "question": "Friction is magic?", "answer": "false",
             "source_chunk_ids": ["does-not-exist"], "source_pages": []},
        ]
    })
    monkeypatch.setattr(ef, "chat_json", lambda **k: fake)

    qs, meta = ef._grounded_questions(
        blueprint=[{"question_type": "mcq", "topic": "Friction", "difficulty": "medium"}],
        evidence=evidence, doc_names={"d1": "Mechanics.pdf"}, diff="medium",
    )
    assert meta["model"] == "fake-model"
    assert len(qs) == 2
    assert qs[0]["validation"]["status"] == "grounded"
    assert qs[0]["source_chunk_ids"] == ["c1"]
    assert qs[0]["source"] == "Mechanics.pdf, 4"
    assert qs[1]["validation"]["status"] == "ungrounded"
    assert qs[1]["source_chunk_ids"] == []


def test_grounded_questions_drops_empty(monkeypatch):
    fake = _FakeChatResult({"questions": [{"question_type": "mcq", "question": ""}]})
    monkeypatch.setattr(ef, "chat_json", lambda **k: fake)
    qs, _ = ef._grounded_questions(
        blueprint=[{"question_type": "mcq", "topic": None, "difficulty": "easy"}],
        evidence=[{"chunkId": "c1", "documentId": "d1", "pageStart": 1, "text": "x"}],
        doc_names={"d1": "a.pdf"}, diff="easy",
    )
    assert qs == []


# ── mastery recording (grade → mastery) ─────────────────────────────────────────


class _Res:
    def __init__(self, data):
        self.data = data


class _Q:
    def __init__(self, table, store):
        self.t = table
        self.s = store
        self._filters: dict = {}

    def select(self, *a, **k):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def limit(self, *a, **k):
        return self

    def upsert(self, row, **k):
        self.s.setdefault(self.t, []).append(("upsert", row))
        return self

    def execute(self):
        rows = [r for r in self.s.get(self.t, []) if isinstance(r, dict)]
        for col, val in self._filters.items():
            rows = [r for r in rows if r.get(col) == val]
        return _Res(rows)


class _SB:
    def __init__(self, store):
        self.s = store

    def table(self, name):
        return _Q(name, self.s)


def test_record_course_topic_attempt_known_topic(monkeypatch):
    store = {
        "document_chunks": [{"id": "c1", "course_id": "course-1", "primary_topic": "Friction"}],
        "user_topic_mastery": [],
    }
    monkeypatch.setattr(ms, "get_supabase", lambda: _SB(store))
    ms.record_course_topic_attempt("u1", "course-1", "Friction", correct=True)
    upserts = [r for r in store["user_topic_mastery"] if isinstance(r, tuple)]
    assert len(upserts) == 1
    row = upserts[0][1]
    assert row["topic"] == "Friction"
    assert row["attempts"] == 1
    assert row["correct"] == 1
    # Laplace: (1 + 1) / (1 + 2)
    assert abs(row["mastery_score"] - (2 / 3)) < 1e-9


def test_record_course_topic_attempt_unknown_topic_skipped(monkeypatch):
    store = {
        "document_chunks": [{"id": "c1", "course_id": "course-1", "primary_topic": "Friction"}],
        "user_topic_mastery": [],
    }
    monkeypatch.setattr(ms, "get_supabase", lambda: _SB(store))
    ms.record_course_topic_attempt("u1", "course-1", "Made Up Topic", correct=False)
    assert store["user_topic_mastery"] == []  # nothing written


def test_record_course_topic_attempt_blank_noop(monkeypatch):
    called = {"n": 0}
    def _boom():
        called["n"] += 1
        raise AssertionError("get_supabase should not be called for blank topic")
    monkeypatch.setattr(ms, "get_supabase", _boom)
    ms.record_course_topic_attempt("u1", "course-1", "  ", correct=True)
    assert called["n"] == 0

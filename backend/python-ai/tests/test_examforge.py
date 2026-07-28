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


# ── persistence hardening (Stage 5) ─────────────────────────────────────────────
#
# An ExamForge exam must be genuinely persisted before it can be graded:
#   - success  → every returned question carries a DB id + a sessionId is present
#   - failure  → a CLEAR error, and NO gradeable questions (so the UI can't start
#                an exam that can never be graded/tracked).


class _InsertQ:
    """Minimal fake table query that records inserts and returns canned rows."""

    def __init__(self, table, store, behaviour):
        self.t = table
        self.s = store
        self.b = behaviour
        self._payload = None

    def insert(self, payload, **k):
        self._payload = payload
        self.s.setdefault(self.t, []).append(payload)
        return self

    def execute(self):
        if self.t == "exam_sessions":
            mode = self.b.get("session", "ok")
            if mode == "raise":
                raise RuntimeError("db down")
            if mode == "no_id":
                return _Res([{}])
            return _Res([{"id": "sess-1"}])
        if self.t == "exam_questions":
            mode = self.b.get("questions", "ok")
            n = len(self._payload) if isinstance(self._payload, list) else 1
            if mode == "raise":
                raise RuntimeError("db down")
            if mode == "empty":
                return _Res([])
            if mode == "missing_id":
                # one row comes back without an id
                return _Res([{"id": f"q-{i}"} if i else {} for i in range(n)])
            return _Res([{"id": f"q-{i}"} for i in range(n)])
        return _Res([])


class _InsertSB:
    def __init__(self, store, behaviour):
        self.s = store
        self.b = behaviour

    def table(self, name):
        return _InsertQ(name, self.s, self.b)


def _stub_generation(monkeypatch, questions):
    """Bypass retrieval/LLM so generate_examforge runs straight to persistence."""
    monkeypatch.setattr(ef, "get_course_topic_map", lambda *a, **k: [])
    monkeypatch.setattr(ef, "_pool_evidence", lambda **k: [{"chunkId": "c1", "documentId": "d1"}])
    monkeypatch.setattr(
        ef, "_grounded_questions",
        lambda **k: (questions, {"model": "m", "promptTokens": 1, "completionTokens": 2}),
    )
    monkeypatch.setattr(ef, "_fetch_course_topics", lambda *a, **k: ["Friction"])


_SAMPLE_QS = [
    {"id": None, "type": "mcq", "question": "Q1?", "options": ["a", "b", "c", "d"],
     "answer": "A", "explanation": "", "difficulty": "medium", "topic": "Friction",
     "points": 1, "sources": [{"fileName": "d.pdf", "pages": "4"}],
     "validation": {"status": "grounded", "score": 1}},
    {"id": None, "type": "true_false", "question": "Q2?", "options": ["True", "False"],
     "answer": "true", "explanation": "", "difficulty": "easy", "topic": "Friction",
     "points": 1, "sources": [], "validation": {"status": "grounded", "score": 1}},
]


def test_generate_examforge_success_persists_ids_and_session(monkeypatch):
    _stub_generation(monkeypatch, [dict(q) for q in _SAMPLE_QS])
    monkeypatch.setattr(ef, "get_supabase", lambda: _InsertSB({}, {}))
    out = ef.generate_examforge(
        user_id="u1", course_id="c1", document_ids=["d1"], requested_count=2,
        difficulty="medium", topic=None, question_types=["mcq", "true_false"],
        doc_names={"d1": "d.pdf"},
    )
    assert out["error"] is None
    assert out["sessionId"] == "sess-1"
    assert out["actualCount"] == 2
    assert len(out["questions"]) == 2
    # every returned question carries its persisted DB id
    assert all(q.get("id") for q in out["questions"])
    assert [q["id"] for q in out["questions"]] == ["q-0", "q-1"]


def test_generate_examforge_session_insert_failure_returns_error(monkeypatch):
    _stub_generation(monkeypatch, [dict(q) for q in _SAMPLE_QS])
    monkeypatch.setattr(ef, "get_supabase", lambda: _InsertSB({}, {"session": "raise"}))
    out = ef.generate_examforge(
        user_id="u1", course_id="c1", document_ids=["d1"], requested_count=2,
        difficulty="medium", topic=None, question_types=["mcq", "true_false"],
        doc_names={"d1": "d.pdf"},
    )
    assert out["error"]  # clear error message present
    assert out["sessionId"] is None
    assert out["questions"] == []      # no gradeable exam returned
    assert out["actualCount"] == 0


def test_generate_examforge_session_no_id_returns_error(monkeypatch):
    _stub_generation(monkeypatch, [dict(q) for q in _SAMPLE_QS])
    monkeypatch.setattr(ef, "get_supabase", lambda: _InsertSB({}, {"session": "no_id"}))
    out = ef.generate_examforge(
        user_id="u1", course_id="c1", document_ids=["d1"], requested_count=2,
        difficulty="medium", topic=None, question_types=["mcq"],
        doc_names={"d1": "d.pdf"},
    )
    assert out["error"]
    assert out["sessionId"] is None
    assert out["questions"] == []


def test_generate_examforge_question_insert_empty_returns_error(monkeypatch):
    _stub_generation(monkeypatch, [dict(q) for q in _SAMPLE_QS])
    monkeypatch.setattr(ef, "get_supabase", lambda: _InsertSB({}, {"questions": "empty"}))
    out = ef.generate_examforge(
        user_id="u1", course_id="c1", document_ids=["d1"], requested_count=2,
        difficulty="medium", topic=None, question_types=["mcq"],
        doc_names={"d1": "d.pdf"},
    )
    assert out["error"]
    assert out["questions"] == []


def test_generate_examforge_question_missing_id_returns_error(monkeypatch):
    _stub_generation(monkeypatch, [dict(q) for q in _SAMPLE_QS])
    monkeypatch.setattr(ef, "get_supabase", lambda: _InsertSB({}, {"questions": "missing_id"}))
    out = ef.generate_examforge(
        user_id="u1", course_id="c1", document_ids=["d1"], requested_count=2,
        difficulty="medium", topic=None, question_types=["mcq"],
        doc_names={"d1": "d.pdf"},
    )
    assert out["error"]
    assert out["questions"] == []  # partially-saved exam is rejected wholesale

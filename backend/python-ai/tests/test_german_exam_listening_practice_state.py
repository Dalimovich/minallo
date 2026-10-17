"""german_exam_listening_practice_state — the server-side grading-state hold for the generated
(AI) Hören path (public.german_exam_listening_practice_generations). Offline: a small fake
Supabase/PostgREST double, no real database connection. Mirrors
test_german_exam_dsh_practice_state.py's double, minus DSH's one-time `graded_at` claim: this
table's read (get_grading_entry) is gated only by ownership + expiry, and may be called more than
once for the same question — a Hören part has several questions graded independently, and the
existing hint/retry UX legitimately re-submits the same question more than once."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services import german_exam_listening_practice_state as state


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQuery:
    def __init__(self, rows: list[dict], mode: str, payload: dict | None = None) -> None:
        self._rows = rows
        self._mode = mode  # "insert" | "select"
        self._payload = payload or {}
        self._filters: list[tuple[str, str, object]] = []

    def eq(self, col: str, val: object) -> "_FakeQuery":
        self._filters.append((col, "eq", val))
        return self

    def gt(self, col: str, val: object) -> "_FakeQuery":
        self._filters.append((col, "gt", val))
        return self

    def select(self, _cols: str) -> "_FakeQuery":
        return self

    def _matches(self, row: dict) -> bool:
        for col, op, val in self._filters:
            if op == "eq" and str(row.get(col)) != str(val):
                return False
            if op == "gt" and not (row.get(col) is not None and str(row[col]) > str(val)):
                return False
        return True

    def execute(self) -> _FakeResponse:
        if self._mode == "insert":
            row = {
                "created_at": datetime.now(timezone.utc).isoformat(),
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
                **self._payload,
            }
            self._rows.append(row)
            return _FakeResponse([dict(row)])
        matched = [row for row in self._rows if self._matches(row)]
        return _FakeResponse([dict(row) for row in matched])


class _FakeTable:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def insert(self, payload: dict) -> _FakeQuery:
        return _FakeQuery(self._rows, "insert", payload)

    def select(self, _cols: str) -> _FakeQuery:
        return _FakeQuery(self._rows, "select")


class FakeSupabase:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def table(self, name: str) -> _FakeTable:
        assert name == state.TABLE
        return _FakeTable(self.rows)


@pytest.fixture()
def fake_supabase(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    fake = FakeSupabase()
    monkeypatch.setattr(state, "get_supabase", lambda: fake)
    return fake


GRADING_CONTENT = {
    "q1": {"taskType": "sentence_completion_mc3", "correct": 1},
    "q2": {"taskType": "sentence_completion_mc3", "correct": 0},
}


def test_create_generation_stores_the_given_id_and_content(fake_supabase: FakeSupabase) -> None:
    returned_id = state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    assert returned_id == "gen-1"
    assert fake_supabase.rows[0]["id"] == "gen-1"
    assert fake_supabase.rows[0]["user_id"] == "user-a"
    assert fake_supabase.rows[0]["part_id"] == "hv2"
    assert fake_supabase.rows[0]["grading_content"] == GRADING_CONTENT


def test_valid_question_is_read_back(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    entry = state.get_grading_entry("user-a", "gen-1", "q1")
    assert entry == {"taskType": "sentence_completion_mc3", "correct": 1}


def test_same_question_can_be_read_more_than_once(fake_supabase: FakeSupabase) -> None:
    """Unlike DSH's one-time claim, a Hören question may legitimately be re-submitted after a
    hint — the read must not consume or lock the row."""
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    first = state.get_grading_entry("user-a", "gen-1", "q1")
    second = state.get_grading_entry("user-a", "gen-1", "q1")
    assert first == second == {"taskType": "sentence_completion_mc3", "correct": 1}


def test_a_different_question_in_the_same_generation_is_also_readable(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    assert state.get_grading_entry("user-a", "gen-1", "q1") is not None
    assert state.get_grading_entry("user-a", "gen-1", "q2") == {"taskType": "sentence_completion_mc3", "correct": 0}


def test_unknown_generation_id_fails_closed(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    assert state.get_grading_entry("user-a", "does-not-exist", "q1") is None


def test_unknown_question_id_fails_closed(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    assert state.get_grading_entry("user-a", "gen-1", "does-not-exist") is None


def test_user_a_cannot_read_user_bs_generation(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    assert state.get_grading_entry("user-b", "gen-1", "q1") is None
    # The rightful owner can still read it afterwards — a failed cross-user attempt doesn't harm the row.
    assert state.get_grading_entry("user-a", "gen-1", "q1") is not None


def test_expired_generation_fails_closed(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "hv2", GRADING_CONTENT, generation_id="gen-1")
    fake_supabase.rows[0]["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    assert state.get_grading_entry("user-a", "gen-1", "q1") is None

"""german_exam_dsh_practice_state — the server-side grading-state hold for the DSH LV/HV
practice path (public.dsh_lv_hv_practice_generations). Offline: a small fake Supabase/PostgREST
double, no real database connection. The double implements exactly the filter semantics
create_generation/claim_generation_for_grading rely on (eq/is_/gt applied to an UPDATE, in one
step) so these tests exercise the REAL ownership/expiry/one-time-use logic, not a mock of it.
True multi-process concurrency atomicity is a Postgres guarantee (a single UPDATE statement is
atomic) that no Python-level test can exercise directly; what IS tested here is that the
application logic, given atomic single-statement semantics, behaves correctly — i.e. that a
second claim attempt against an already-graded_at row matches zero rows, exactly as a real
concurrent UPDATE would."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.services import german_exam_dsh_practice_state as state


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQuery:
    def __init__(self, rows: list[dict], mode: str, payload: dict | None = None) -> None:
        self._rows = rows
        self._mode = mode  # "insert" | "update"
        self._payload = payload or {}
        self._filters: list[tuple[str, str, object]] = []

    def eq(self, col: str, val: object) -> "_FakeQuery":
        self._filters.append((col, "eq", val))
        return self

    def is_(self, col: str, val: str) -> "_FakeQuery":
        self._filters.append((col, "is", val))
        return self

    def gt(self, col: str, val: object) -> "_FakeQuery":
        self._filters.append((col, "gt", val))
        return self

    def _matches(self, row: dict) -> bool:
        for col, op, val in self._filters:
            if op == "eq" and str(row.get(col)) != str(val):
                return False
            if op == "is" and val == "null" and row.get(col) is not None:
                return False
            if op == "gt" and not (row.get(col) is not None and str(row[col]) > str(val)):
                return False
        return True

    def execute(self) -> _FakeResponse:
        if self._mode == "insert":
            row = {
                "id": str(uuid.uuid4()),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
                "graded_at": None,
                **self._payload,
            }
            self._rows.append(row)
            return _FakeResponse([dict(row)])
        # update: one atomic pass — filter THEN mutate, in a single step, so a second call that
        # sees graded_at already set (from the first call's mutation) matches nothing.
        matched = [row for row in self._rows if self._matches(row)]
        for row in matched:
            row.update(self._payload)
        return _FakeResponse([dict(row) for row in matched])


class _FakeTable:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def insert(self, payload: dict) -> _FakeQuery:
        return _FakeQuery(self._rows, "insert", payload)

    def update(self, payload: dict) -> _FakeQuery:
        return _FakeQuery(self._rows, "update", payload)


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


GRADING_CONTENT = {"tasks": [{"form": "questions", "items": [{"itemId": "q1", "question": "Frage?", "maxPoints": 1, "requiredPoints": [{"pointId": "p1", "description": "x", "points": 1}]}]}]}


def test_create_generation_returns_an_id_and_stores_the_given_content(fake_supabase: FakeSupabase) -> None:
    generation_id = state.create_generation("user-a", "lv", GRADING_CONTENT)
    assert generation_id
    assert fake_supabase.rows[0]["user_id"] == "user-a"
    assert fake_supabase.rows[0]["part"] == "lv"
    assert fake_supabase.rows[0]["grading_content"] == GRADING_CONTENT
    assert fake_supabase.rows[0]["graded_at"] is None


def test_valid_generation_is_claimed_and_returns_the_stored_grading_content(fake_supabase: FakeSupabase) -> None:
    generation_id = state.create_generation("user-a", "lv", GRADING_CONTENT)
    claimed = state.claim_generation_for_grading("user-a", generation_id)
    assert claimed == GRADING_CONTENT


def test_unknown_generation_id_fails_closed(fake_supabase: FakeSupabase) -> None:
    state.create_generation("user-a", "lv", GRADING_CONTENT)
    assert state.claim_generation_for_grading("user-a", str(uuid.uuid4())) is None


def test_user_a_cannot_claim_user_bs_generation(fake_supabase: FakeSupabase) -> None:
    generation_id = state.create_generation("user-a", "lv", GRADING_CONTENT)
    assert state.claim_generation_for_grading("user-b", generation_id) is None
    # The row must survive untouched — a failed cross-user attempt must not consume it either.
    assert fake_supabase.rows[0]["graded_at"] is None
    # The rightful owner can still claim it afterwards.
    assert state.claim_generation_for_grading("user-a", generation_id) == GRADING_CONTENT


def test_expired_generation_fails_closed(fake_supabase: FakeSupabase) -> None:
    generation_id = state.create_generation("user-a", "lv", GRADING_CONTENT)
    fake_supabase.rows[0]["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    assert state.claim_generation_for_grading("user-a", generation_id) is None


def test_repeated_claim_of_an_already_graded_generation_fails_closed(fake_supabase: FakeSupabase) -> None:
    generation_id = state.create_generation("user-a", "lv", GRADING_CONTENT)
    first = state.claim_generation_for_grading("user-a", generation_id)
    second = state.claim_generation_for_grading("user-a", generation_id)
    assert first == GRADING_CONTENT
    assert second is None


def test_two_concurrent_looking_claims_in_a_row_only_one_succeeds(fake_supabase: FakeSupabase) -> None:
    """Simulates two requests racing to grade the same generation: whichever's UPDATE reaches
    the (fake) database first claims it; the other matches zero rows. This is the Python-level
    analogue of the real atomic SQL UPDATE ... WHERE graded_at IS NULL ... RETURNING."""
    generation_id = state.create_generation("user-a", "lv", GRADING_CONTENT)
    results = [state.claim_generation_for_grading("user-a", generation_id) for _ in range(2)]
    assert results.count(GRADING_CONTENT) == 1
    assert results.count(None) == 1

"""Router-level tests for POST /german-exam/listening/grade-item — the only way to learn whether
a generated (AI) Hören answer was correct now that german_exam_generator._secure_listening_
envelope strips every answer-key field from the generate response. Mirrors
test_german_exam_dsh_lv_hv_router.py's style and FakeSupabase double (same filter semantics:
eq/gt applied in one step), adapted for this table's plain-read contract (no DSH-style one-time
`graded_at` claim — a Hören question may legitimately be re-graded after a hint/retry).

No real provider/model call and no real database connection happen anywhere in this file; the
row under test is seeded directly via german_exam_listening_practice_state.create_generation
against the same fake double, not through a real /german-exam/generate call."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
AUTH = {"X-Internal-Token": "test-token"}


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings  # noqa: WPS433

    get_settings.cache_clear()


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQuery:
    def __init__(self, rows: list[dict], mode: str, payload: dict | None = None) -> None:
        self._rows, self._mode, self._payload, self._filters = rows, mode, payload or {}, []

    def eq(self, col, val):
        self._filters.append((col, "eq", val)); return self

    def gt(self, col, val):
        self._filters.append((col, "gt", val)); return self

    def select(self, _cols):
        return self

    def _matches(self, row):
        for col, op, val in self._filters:
            if op == "eq" and str(row.get(col)) != str(val):
                return False
            if op == "gt" and not (row.get(col) is not None and str(row[col]) > str(val)):
                return False
        return True

    def execute(self):
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


class FakeSupabase:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def table(self, name: str):
        class _T:
            def __init__(self, rows): self._rows = rows
            def insert(self, payload): return _FakeQuery(self._rows, "insert", payload)
            def select(self, _cols): return _FakeQuery(self._rows, "select")
        return _T(self.rows)


@pytest.fixture()
def fake_supabase(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    fake = FakeSupabase()
    from app.services import german_exam_listening_practice_state as state_mod

    monkeypatch.setattr(state_mod, "get_supabase", lambda: fake)
    return fake


@pytest.fixture()
def client(fake_supabase: FakeSupabase) -> TestClient:
    from app.main import app  # noqa: WPS433

    return TestClient(app)


def _seed(generation_id: str, user_id: str, grading_content: dict) -> None:
    from app.services import german_exam_listening_practice_state as state_mod

    state_mod.create_generation(user_id, "hv2", grading_content, generation_id=generation_id)


def _grade(client: TestClient, generation_id: str, question_id: str, selected, user: str = USER_A):
    return client.post(
        "/german-exam/listening/grade-item",
        json={"userId": user, "generationId": generation_id, "questionId": question_id, "selected": selected},
        headers=AUTH,
    )


MC3_CONTENT = {"q1": {"taskType": "sentence_completion_mc3", "correct": 1}}
MATCHING_CONTENT = {"q1": {"taskType": "speaker_statement_matching", "correct": "speaker_2", "evidenceSegmentIds": ["s2"]}}
NOTE_CONTENT = {"q1": {"taskType": "structured_note_completion", "correct": "12. März"}}
TRISTATE_CONTENT = {"q1": {"taskType": "listening_tristate", "correct": "falsch"}}


def test_correct_mc3_answer(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    resp = _grade(client, "gen-1", "q1", 1)
    assert resp.status_code == 200
    body = resp.json()
    assert body["correct"] is True
    assert body["correctAnswer"] == 1


def test_incorrect_mc3_answer_still_reveals_the_correct_one(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    resp = _grade(client, "gen-1", "q1", 0)
    body = resp.json()
    assert body["correct"] is False
    assert body["correctAnswer"] == 1  # reveal happens only AFTER the attempt, which this is


def test_matching_answer_includes_evidence_segment_ids_for_the_replay_button(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MATCHING_CONTENT)
    resp = _grade(client, "gen-1", "q1", "speaker_2")
    body = resp.json()
    assert body["correct"] is True
    assert body["evidenceSegmentIds"] == ["s2"]


def test_matching_no_match_sentinel(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, {"q1": {"taskType": "speaker_statement_matching", "correct": None}})
    resp = _grade(client, "gen-1", "q1", "no_match")
    assert resp.json()["correct"] is True


def test_note_completion_is_case_and_whitespace_insensitive(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, NOTE_CONTENT)
    resp = _grade(client, "gen-1", "q1", " 12. märz ")
    assert resp.json()["correct"] is True


def test_tristate_answer(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, TRISTATE_CONTENT)
    resp = _grade(client, "gen-1", "q1", "falsch")
    assert resp.json()["correct"] is True


# ---- ownership / expiry / unknown — all the same generic 404 -----------------------------------

def test_user_a_cannot_grade_user_bs_generation(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    resp = _grade(client, "gen-1", "q1", 1, user=USER_B)
    assert resp.status_code == 404
    # the rightful owner can still grade it afterwards — a failed cross-user attempt doesn't consume anything
    own = _grade(client, "gen-1", "q1", 1, user=USER_A)
    assert own.status_code == 200


def test_unknown_generation_id_is_404(client: TestClient, fake_supabase: FakeSupabase) -> None:
    resp = _grade(client, "does-not-exist", "q1", 1)
    assert resp.status_code == 404


def test_unknown_question_id_is_404(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    resp = _grade(client, "gen-1", "does-not-exist", 1)
    assert resp.status_code == 404


def test_expired_generation_is_404(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    fake_supabase.rows[0]["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    resp = _grade(client, "gen-1", "q1", 1)
    assert resp.status_code == 404


# ---- repeat grading is allowed (unlike DSH's one-time claim) -----------------------------------

def test_the_same_question_can_be_graded_more_than_once(client: TestClient, fake_supabase: FakeSupabase) -> None:
    """A Hören question may legitimately be re-attempted after a hint — the second check-answer
    click for the same question must not 404 just because it was already graded once."""
    _seed("gen-1", USER_A, MC3_CONTENT)
    first = _grade(client, "gen-1", "q1", 0)
    second = _grade(client, "gen-1", "q1", 1)
    assert first.status_code == 200 and first.json()["correct"] is False
    assert second.status_code == 200 and second.json()["correct"] is True


# ---- client cannot inject a replacement answer --------------------------------------------------

def test_client_cannot_supply_or_override_the_correct_answer(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    forged = {
        "userId": USER_A, "generationId": "gen-1", "questionId": "q1", "selected": 0,
        "correct": True, "correctAnswer": 0, "gradingContent": {"q1": {"correct": 0}},
    }
    resp = client.post("/german-exam/listening/grade-item", json=forged, headers=AUTH)
    assert resp.status_code == 200
    # Graded against the REAL stored answer (1), never the forged "correct": True / correctAnswer: 0.
    body = resp.json()
    assert body["correct"] is False
    assert body["correctAnswer"] == 1


def test_malformed_selected_is_a_422(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, MC3_CONTENT)
    resp = client.post(
        "/german-exam/listening/grade-item",
        json={"userId": USER_A, "generationId": "gen-1", "questionId": "q1", "selected": None},
        headers=AUTH,
    )
    assert resp.status_code == 422


def test_oversized_selected_string_is_a_422(client: TestClient, fake_supabase: FakeSupabase) -> None:
    _seed("gen-1", USER_A, NOTE_CONTENT)
    resp = client.post(
        "/german-exam/listening/grade-item",
        json={"userId": USER_A, "generationId": "gen-1", "questionId": "q1", "selected": "x" * 2001},
        headers=AUTH,
    )
    assert resp.status_code == 422

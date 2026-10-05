"""Router-level tests for POST /german-exam/dsh/lv-hv/generate and .../grade — the DSH LV/HV
practice/content-evaluation path, now backed by server-side grading state
(public.dsh_lv_hv_practice_generations via german_exam_dsh_practice_state). Neither endpoint
touches DSH availability, and neither ever returns an official DSH score, percent-of-official-
scale, or DSH-1/2/3 level.

MOCKED throughout: generation (generate_dsh_lv_part/generate_dsh_hv_part), the semantic matcher
(llm_content_matcher), and Supabase (a small in-memory fake standing in for
dsh_practice_state.get_supabase — see FakeSupabase below, the same double
test_german_exam_dsh_practice_state.py uses to prove the real ownership/expiry/one-time-use
logic). No real provider/model call and no real database connection happen anywhere in this
file."""

from __future__ import annotations

import os
import uuid
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


# ---- minimal fake Supabase/PostgREST double (mirrors test_german_exam_dsh_practice_state.py) ---
class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQuery:
    def __init__(self, rows: list[dict], mode: str, payload: dict | None = None) -> None:
        self._rows, self._mode, self._payload, self._filters = rows, mode, payload or {}, []

    def eq(self, col, val):
        self._filters.append((col, "eq", val)); return self

    def is_(self, col, val):
        self._filters.append((col, "is", val)); return self

    def gt(self, col, val):
        self._filters.append((col, "gt", val)); return self

    def _matches(self, row):
        for col, op, val in self._filters:
            if op == "eq" and str(row.get(col)) != str(val):
                return False
            if op == "is" and val == "null" and row.get(col) is not None:
                return False
            if op == "gt" and not (row.get(col) is not None and str(row[col]) > str(val)):
                return False
        return True

    def execute(self):
        if self._mode == "insert":
            row = {
                "id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc).isoformat(),
                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
                "graded_at": None, **self._payload,
            }
            self._rows.append(row)
            return _FakeResponse([dict(row)])
        matched = [row for row in self._rows if self._matches(row)]
        for row in matched:
            row.update(self._payload)
        return _FakeResponse([dict(row) for row in matched])


class FakeSupabase:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def table(self, name: str):
        class _T:
            def __init__(self, rows): self._rows = rows
            def insert(self, payload): return _FakeQuery(self._rows, "insert", payload)
            def update(self, payload): return _FakeQuery(self._rows, "update", payload)
        return _T(self.rows)


def _lv_content(item_count: int = 2) -> dict:
    items = [
        {
            "itemId": f"q{i}", "question": f"Frage {i}?",
            "requiredPoints": [{"pointId": f"p{i}", "description": f"Punkt {i}", "points": 1}],
            "maxPoints": 1, "referenceAnswer": f"Antwort {i}.", "gradingNotes": "secret notes",
            **({"errorfulVariant": f"Antwort {i} falsch."} if i == 1 else {}),
        }
        for i in range(1, item_count + 1)
    ]
    return {"sourceId": "src-1", "source": {"text": "Ein Lesetext über Forschung." * 20}, "tasks": [{"form": "questions", "items": items}]}


def _hv_content(item_count: int = 2) -> dict:
    content = _lv_content(item_count)
    content["lectureText"] = content.pop("source")["text"]
    del content["sourceId"]
    return content


@pytest.fixture()
def fake_supabase(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    fake = FakeSupabase()
    from app.services import german_exam_dsh_practice_state as state_mod

    monkeypatch.setattr(state_mod, "get_supabase", lambda: fake)
    return fake


@pytest.fixture()
def client(fake_supabase: FakeSupabase, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod, "generate_dsh_lv_part", lambda profile, part, plan, topic: (_lv_content(), {}))
    monkeypatch.setattr(router_mod, "generate_dsh_hv_part", lambda profile, part, plan, topic: (_hv_content(), {}))
    router_mod._DSH_LV_HV_PART_SPECS["lv"] = ("reading", "lv_1", router_mod.generate_dsh_lv_part)
    router_mod._DSH_LV_HV_PART_SPECS["hv"] = ("listening", "hv_1", router_mod.generate_dsh_hv_part)
    # Default matcher: full credit for any non-empty answer. Individual tests override this.
    monkeypatch.setattr(
        router_mod.dsh_grading, "llm_content_matcher",
        lambda question, answer, points, **kw: {p.point_id for p in points} if (answer or "").strip() else set(),
    )

    from app.main import app  # noqa: WPS433

    return TestClient(app)


def _generate(client: TestClient, part: str, user: str = USER_A) -> dict:
    resp = client.post("/german-exam/dsh/lv-hv/generate", json={"userId": user, "part": part}, headers=AUTH)
    assert resp.status_code == 200
    return resp.json()


def _grade(client: TestClient, part: str, generation_id: str, answers: list[dict], user: str = USER_A):
    return client.post(
        "/german-exam/dsh/lv-hv/grade",
        json={"userId": user, "part": part, "generationId": generation_id, "answers": answers},
        headers=AUTH,
    )


_ANSWER_KEY_MARKERS = ("requiredPoints", "optionalPoints", "referenceAnswer", "errorfulVariant", "gradingNotes", "gradingContent")


def _assert_no_answer_key_anywhere(value) -> None:
    serialized = str(value)
    for marker in _ANSWER_KEY_MARKERS:
        assert marker not in serialized, f"{marker!r} leaked into the response: {serialized}"


# ---- generate: no answer key anywhere, no gradingContent field at all -------------------------
def test_generate_response_contains_no_answer_key_fields_anywhere_recursively(client: TestClient) -> None:
    body = _generate(client, "lv")
    assert set(body) == {"kind", "part", "generationId", "content"}
    _assert_no_answer_key_anywhere(body)
    learner_item = body["content"]["tasks"][0]["items"][0]
    assert set(learner_item) == {"itemId", "question"}


def test_generate_hv_uses_the_hv_generator_and_is_equally_clean(client: TestClient) -> None:
    body = _generate(client, "hv")
    assert body["part"] == "hv"
    assert "lectureText" in body["content"]
    _assert_no_answer_key_anywhere(body)


def test_generate_failure_returns_502_not_a_guessed_task(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod
    from app.services.german_exam_dsh_generators import DshGenerationError

    def failing(*a, **kw):
        raise DshGenerationError("simulated generation failure")

    monkeypatch.setattr(router_mod, "generate_dsh_lv_part", failing)
    router_mod._DSH_LV_HV_PART_SPECS["lv"] = ("reading", "lv_1", failing)
    resp = client.post("/german-exam/dsh/lv-hv/generate", json={"userId": USER_A, "part": "lv"}, headers=AUTH)
    assert resp.status_code == 502


# ---- grade: real server-side state, ownership, expiry, one-time-use ---------------------------
def test_valid_submission_uses_stored_server_side_state_and_returns_a_raw_result(client: TestClient) -> None:
    generated = _generate(client, "lv")
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}, {"itemId": "q2", "answer": "Antwort 2."}])
    assert resp.status_code == 200
    body = resp.json()
    assert body["rawPoints"] == 2 and body["rawMaxPoints"] == 2 and body["percent"] == 100.0
    assert body["officialDshScore"] is None and body["officialScoreAvailable"] is False


def test_valid_hv_submission_also_returns_a_raw_result(client: TestClient) -> None:
    generated = _generate(client, "hv")
    resp = _grade(client, "hv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}, {"itemId": "q2", "answer": "Antwort 2."}])
    assert resp.status_code == 200
    assert resp.json()["part"] == "hv"


def test_zero_match_scores_zero(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda *a, **kw: set())
    generated = _generate(client, "lv")
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "falsch"}, {"itemId": "q2", "answer": "auch falsch"}])
    body = resp.json()
    assert body["rawPoints"] == 0 and body["percent"] == 0.0


def test_empty_answer_scores_zero_without_erroring(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda *a, **kw: set())
    generated = _generate(client, "lv", )
    resp = _grade(client, "lv", generated["generationId"], [])
    assert resp.status_code == 200
    assert resp.json()["rawPoints"] == 0


def test_multiple_questions_all_appear_in_the_items_list(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod, "generate_dsh_lv_part", lambda profile, part, plan, topic: (_lv_content(5), {}))
    router_mod._DSH_LV_HV_PART_SPECS["lv"] = ("reading", "lv_1", router_mod.generate_dsh_lv_part)
    generated = _generate(client, "lv")
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": f"q{i}", "answer": "Antwort 1."} for i in range(1, 6)])
    body = resp.json()
    assert [i["itemId"] for i in body["items"]] == [f"q{i}" for i in range(1, 6)]


def test_server_side_data_integrity_problem_fails_as_502_not_a_crash(client: TestClient, fake_supabase: FakeSupabase) -> None:
    """The client can no longer send malformed content (section 7) — this proves that IF the
    stored state were ever malformed (a server-side bug, never a client input), grading fails
    safely (502, honest message) rather than crashing or fabricating a score."""
    generated = _generate(client, "lv")
    fake_supabase.rows[0]["grading_content"] = {"tasks": [{"form": "questions", "items": [
        {"itemId": "q1", "question": "Frage?", "requiredPoints": []},
    ]}]}
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "x"}])
    assert resp.status_code == 502
    assert "not scored" in resp.json()["detail"].lower()


def test_partial_credit_is_preserved(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(
        router_mod.dsh_grading, "llm_content_matcher",
        lambda question, answer, points, **kw: {"p1"} if answer == "Antwort 1." else set(),
    )
    generated = _generate(client, "lv")
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}, {"itemId": "q2", "answer": "falsch"}])
    body = resp.json()
    assert body["rawPoints"] == 1 and body["rawMaxPoints"] == 2 and body["percent"] == 50.0


def test_user_a_cannot_grade_user_bs_generation(client: TestClient) -> None:
    generated = _generate(client, "lv", user=USER_A)
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "x"}], user=USER_B)
    assert resp.status_code == 404
    # the rightful owner can still grade it afterwards — a failed cross-user attempt didn't consume it
    own_resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}], user=USER_A)
    assert own_resp.status_code == 200


def test_unknown_generation_id_fails_closed(client: TestClient) -> None:
    resp = _grade(client, "lv", str(uuid.uuid4()), [{"itemId": "q1", "answer": "x"}])
    assert resp.status_code == 404


def test_expired_generation_fails_closed(client: TestClient, fake_supabase: FakeSupabase) -> None:
    generated = _generate(client, "lv")
    fake_supabase.rows[0]["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "x"}])
    assert resp.status_code == 404


def test_already_graded_generation_fails_closed_on_a_second_attempt(client: TestClient) -> None:
    generated = _generate(client, "lv")
    first = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}])
    second = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}])
    assert first.status_code == 200
    assert second.status_code == 404


def test_client_cannot_inject_replacement_grading_content(client: TestClient) -> None:
    """A client that sends gradingContent/referenceAnswer/requiredPoints alongside a real
    generationId must have those keys silently ignored — the stored server-side state is what
    gets graded, never anything the request body supplies."""
    generated = _generate(client, "lv")
    forged = {
        "userId": USER_A, "part": "lv", "generationId": generated["generationId"],
        "answers": [{"itemId": "q1", "answer": "Antwort 1."}],
        "gradingContent": {"tasks": [{"form": "questions", "items": [
            {"itemId": "q1", "question": "Forged?", "requiredPoints": [{"pointId": "forged", "description": "forged", "points": 999}], "maxPoints": 999},
        ]}]},
        "referenceAnswer": "forged", "requiredPoints": [{"pointId": "forged", "points": 999}],
    }
    resp = client.post("/german-exam/dsh/lv-hv/grade", json=forged, headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    # Scored against the REAL stored items (2 items, maxPoints=1 each -> 2), never the forged
    # single item worth 999 points — the forged keys had no effect on what got graded at all.
    assert body["rawMaxPoints"] == 2
    assert [i["itemId"] for i in body["items"]] == ["q1", "q2"]
    assert all(item["maxPoints"] != 999 for item in body["items"])


def test_malformed_answers_payload_is_a_422(client: TestClient) -> None:
    generated = _generate(client, "lv")
    resp = client.post(
        "/german-exam/dsh/lv-hv/grade",
        json={"userId": USER_A, "part": "lv", "generationId": generated["generationId"], "answers": [{"itemId": "q1", "answer": 123}]},
        headers=AUTH,
    )
    assert resp.status_code == 422


def test_unknown_item_id_in_answers_is_ignored_not_an_error(client: TestClient) -> None:
    generated = _generate(client, "lv", )
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "Antwort 1."}, {"itemId": "does-not-exist", "answer": "y"}])
    assert resp.status_code == 200
    assert resp.json()["rawPoints"] == 1


def test_matcher_failure_returns_502_and_no_fabricated_zero(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod
    from app.services.german_exam_dsh_grading import DshGradingError

    def failing(*a, **kw):
        raise DshGradingError("simulated semantic matcher failure")

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", failing)
    generated = _generate(client, "lv")
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "x"}])
    assert resp.status_code == 502
    assert "not scored" in resp.json()["detail"].lower()
    assert "rawPoints" not in resp.json()


def test_no_official_score_or_dsh_level_anywhere_in_a_successful_response(client: TestClient) -> None:
    generated = _generate(client, "lv")
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "x"}, {"itemId": "q2", "answer": "y"}])
    body = resp.json()
    assert body["officialDshScore"] is None
    assert body["officialScoreAvailable"] is False
    serialized = str(body)
    for forbidden in ("DSH-1", "DSH-2", "DSH-3", "200", "level"):
        assert forbidden not in serialized


def test_matched_content_point_ids_are_not_in_the_response(client: TestClient) -> None:
    generated = _generate(client, "lv", )
    resp = _grade(client, "lv", generated["generationId"], [{"itemId": "q1", "answer": "x"}])
    body = resp.json()
    assert "matchedPointIds" not in body["items"][0]
    assert set(body["items"][0]) == {"itemId", "points", "maxPoints"}

"""Router-level tests for POST /german-exam/dsh/lv-hv/generate and .../grade — the DSH LV/HV
practice/content-evaluation path. Neither endpoint touches DSH availability, and neither ever
returns an official DSH score, percent-of-official-scale, or DSH-1/2/3 level.

MOCKED: generation and grading are monkeypatched to deterministic fakes everywhere in this file.
No real provider/model call happens — this proves routing, validation, stripping and response
shape, never live semantic grading."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

USER = "11111111-1111-4111-8111-111111111111"
AUTH = {"X-Internal-Token": "test-token"}


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings  # noqa: WPS433

    get_settings.cache_clear()


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
def client(monkeypatch) -> TestClient:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod, "generate_dsh_lv_part", lambda profile, part, plan, topic: (_lv_content(), {}))
    monkeypatch.setattr(router_mod, "generate_dsh_hv_part", lambda profile, part, plan, topic: (_hv_content(), {}))
    router_mod._DSH_LV_HV_PART_SPECS["lv"] = ("reading", "lv_1", router_mod.generate_dsh_lv_part)
    router_mod._DSH_LV_HV_PART_SPECS["hv"] = ("listening", "hv_1", router_mod.generate_dsh_hv_part)

    from app.main import app  # noqa: WPS433

    return TestClient(app)


# ---- /german-exam/dsh/lv-hv/generate -----------------------------------------------------------
def test_generate_lv_strips_answer_key_but_keeps_grading_content_full(client: TestClient) -> None:
    resp = client.post("/german-exam/dsh/lv-hv/generate", json={"part": "lv"}, headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["part"] == "lv" and body["generationId"]
    learner_item = body["content"]["tasks"][0]["items"][0]
    assert set(learner_item) == {"itemId", "question"}
    for leaked in ("requiredPoints", "referenceAnswer", "errorfulVariant", "gradingNotes", "maxPoints"):
        assert leaked not in learner_item
    full_item = body["gradingContent"]["tasks"][0]["items"][0]
    assert full_item["referenceAnswer"] == "Antwort 1."
    assert full_item["requiredPoints"][0]["description"] == "Punkt 1"


def test_generate_hv_uses_the_hv_generator_and_strips_the_same_way(client: TestClient) -> None:
    resp = client.post("/german-exam/dsh/lv-hv/generate", json={"part": "hv"}, headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["part"] == "hv"
    assert "lectureText" in body["content"] and "lectureText" in body["gradingContent"]
    assert set(body["content"]["tasks"][0]["items"][0]) == {"itemId", "question"}


def test_generate_failure_returns_502_not_a_guessed_task(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod
    from app.services.german_exam_dsh_generators import DshGenerationError

    def failing(*a, **kw):
        raise DshGenerationError("simulated generation failure")

    monkeypatch.setattr(router_mod, "generate_dsh_lv_part", failing)
    router_mod._DSH_LV_HV_PART_SPECS["lv"] = ("reading", "lv_1", failing)
    resp = client.post("/german-exam/dsh/lv-hv/generate", json={"part": "lv"}, headers=AUTH)
    assert resp.status_code == 502


# ---- /german-exam/dsh/lv-hv/grade ---------------------------------------------------------------
def _grade(client: TestClient, part: str, content: dict, answers: dict) -> "object":
    return client.post(
        "/german-exam/dsh/lv-hv/grade",
        json={"part": part, "generationId": "gen-1", "gradingContent": content, "answers": answers},
        headers=AUTH,
    )


def test_valid_lv_submission_returns_a_raw_result(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(
        router_mod.dsh_grading, "llm_content_matcher",
        lambda question, answer, points, **kw: {p.point_id for p in points} if answer.strip() else set(),
    )
    resp = _grade(client, "lv", _lv_content(2), {"q1": "Antwort 1.", "q2": "Antwort 2."})
    assert resp.status_code == 200
    body = resp.json()
    assert body["rawPoints"] == 2 and body["rawMaxPoints"] == 2 and body["percent"] == 100.0
    assert len(body["items"]) == 2
    assert body["officialDshScore"] is None and body["officialScoreAvailable"] is False


def test_valid_hv_submission_returns_a_raw_result(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(
        router_mod.dsh_grading, "llm_content_matcher",
        lambda question, answer, points, **kw: {p.point_id for p in points} if answer.strip() else set(),
    )
    resp = _grade(client, "hv", _hv_content(2), {"q1": "Antwort 1.", "q2": "Antwort 2."})
    assert resp.status_code == 200
    assert resp.json()["part"] == "hv"


def test_partial_content_match_is_reflected_in_the_raw_score(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(
        router_mod.dsh_grading, "llm_content_matcher",
        lambda question, answer, points, **kw: {"p1"} if "q1" in question or answer == "Antwort 1." else set(),
    )
    resp = _grade(client, "lv", _lv_content(2), {"q1": "Antwort 1.", "q2": "falsch"})
    body = resp.json()
    assert body["rawPoints"] == 1 and body["rawMaxPoints"] == 2 and body["percent"] == 50.0


def test_zero_match_scores_zero(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda *a, **kw: set())
    resp = _grade(client, "lv", _lv_content(2), {"q1": "falsch", "q2": "auch falsch"})
    body = resp.json()
    assert body["rawPoints"] == 0 and body["percent"] == 0.0


def test_empty_answer_scores_zero_without_erroring(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda *a, **kw: set())
    resp = _grade(client, "lv", _lv_content(1), {})
    assert resp.status_code == 200
    assert resp.json()["rawPoints"] == 0


def test_multiple_questions_all_appear_in_the_items_list(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda q, a, points, **kw: {p.point_id for p in points})
    resp = _grade(client, "lv", _lv_content(5), {f"q{i}": "x" for i in range(1, 6)})
    body = resp.json()
    assert [i["itemId"] for i in body["items"]] == [f"q{i}" for i in range(1, 6)]


def test_malformed_answers_payload_is_a_422(client: TestClient) -> None:
    resp = client.post(
        "/german-exam/dsh/lv-hv/grade",
        json={"part": "lv", "generationId": "gen-1", "gradingContent": _lv_content(), "answers": {"q1": 123}},
        headers=AUTH,
    )
    assert resp.status_code == 422


def test_unknown_item_id_in_answers_is_ignored_not_an_error(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda q, a, points, **kw: {p.point_id for p in points})
    resp = _grade(client, "lv", _lv_content(1), {"q1": "x", "does-not-exist": "y"})
    assert resp.status_code == 200
    assert resp.json()["rawPoints"] == 1


def test_invalid_content_structure_is_a_400(client: TestClient) -> None:
    broken = {"sourceId": "s", "source": {"text": "x"}, "tasks": [{"form": "questions", "items": [
        {"itemId": "q1", "question": "Frage?", "requiredPoints": []},
    ]}]}
    resp = _grade(client, "lv", broken, {"q1": "x"})
    assert resp.status_code == 400


def test_matcher_failure_returns_502_and_no_guessed_score(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod
    from app.services.german_exam_dsh_grading import DshGradingError

    def failing(*a, **kw):
        raise DshGradingError("simulated semantic matcher failure")

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", failing)
    resp = _grade(client, "lv", _lv_content(1), {"q1": "x"})
    assert resp.status_code == 502
    assert "not scored" in resp.json()["detail"].lower()


def test_no_official_score_or_dsh_level_anywhere_in_a_successful_response(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda q, a, points, **kw: {p.point_id for p in points})
    resp = _grade(client, "lv", _lv_content(2), {"q1": "x", "q2": "y"})
    body = resp.json()
    assert body["officialDshScore"] is None
    assert body["officialScoreAvailable"] is False
    serialized = str(body)
    for forbidden in ("DSH-1", "DSH-2", "DSH-3", "200", "level"):
        assert forbidden not in serialized


def test_matched_content_point_ids_are_not_in_the_response(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.dsh_grading, "llm_content_matcher", lambda q, a, points, **kw: {p.point_id for p in points})
    resp = _grade(client, "lv", _lv_content(1), {"q1": "x"})
    body = resp.json()
    assert "matchedPointIds" not in body["items"][0]
    assert set(body["items"][0]) == {"itemId", "points", "maxPoints"}

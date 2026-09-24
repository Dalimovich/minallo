"""Router-level regression tests for POST /german-exam/grade-writing and
POST /german-exam/speaking.

Covers the profile/task-driven gates that replaced the old TELC-only
hardcodes (part.task_type != "choice_long_form_writing" for writing;
profileId: Literal["telc_c1_hochschule"] for speaking): TELC keeps behaving
exactly as before, TestDaF's writing task types are now admitted through to
the shared grading adapter, and every unsupported profile/task combination
still comes back as a clean 4xx/501 — never a crash, never silent success.

TestDaF SPEAKING is intentionally NOT tested as "accepted": the shared
speaking dispatch (german_exam_speaking_practice.py) is still hardcoded to
telc_c1_hochschule's own two-part structure (STAGES, required-turn sequence,
scoring maxima), so testdaf_digital correctly stays behind the 501 gate here
— see the module docstring next to GRADABLE_SPEAKING_PROFILE_IDS.

No real provider call happens anywhere in this file: grade_writing_submission
and every speaking_practice.* entry point are monkeypatched.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

USER = "11111111-1111-4111-8111-111111111111"


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings  # noqa: WPS433
    get_settings.cache_clear()


@pytest.fixture()
def client(monkeypatch) -> TestClient:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(
        router_mod,
        "grade_writing_submission",
        lambda **kw: {
            "analysis": {"score": {"overall": 80}},
            "rubric": {"overall": 80, "examScoreValue": 40, "examMaxScoreValue": 48},
            "examResultItems": [],
            "scoreValue": 40,
            "maxScoreValue": 48,
        },
    )
    monkeypatch.setattr(router_mod.speaking_practice, "grade_speaking", lambda *a, **kw: {
        "rubric": {}, "scoreValue": 10, "maxScoreValue": 16, "officialMaxScoreValue": 48,
        "completeOfficialEquivalent": False, "feedback": {}, "examResultItems": [],
        "unavailableReason": "stub",
    })

    from app.main import app  # noqa: WPS433
    return TestClient(app)


AUTH = {"X-Internal-Token": "test-token"}


def _writing_payload(profile_id: str, part_id: str, **overrides) -> dict:
    payload = {
        "userId": USER,
        "profileId": profile_id,
        "partId": part_id,
        "topicId": "t1",
        "generationId": "gen-1",
        "writingCoachTaskType": "freier_text",
        "selectedTopic": {
            "questionId": "t1",
            "title": "Test topic",
            "statements": ["Statement one.", "Statement two."],
            "communicativeSituation": "A short communicative situation.",
            "taskInstructions": "Write about it.",
        },
        "text": "Ein ausführlicher Übungstext für die Bewertung." * 3,
    }
    payload.update(overrides)
    return payload


# ── /german-exam/grade-writing ───────────────────────────────────────────────


def test_grade_writing_telc_accepted(client: TestClient) -> None:
    r = client.post(
        "/german-exam/grade-writing", headers=AUTH,
        json=_writing_payload("telc_c1_hochschule", "schreiben_1"),
    )
    assert r.status_code == 200
    assert r.json()["scoreValue"] == 40


def test_grade_writing_testdaf_accepted(client: TestClient) -> None:
    """The core regression: testdaf_digital's argumentative_essay Schreiben
    part used to hit the hardcoded `!= "choice_long_form_writing"` gate and
    always 501. It must now resolve through to the shared grading adapter."""
    r = client.post(
        "/german-exam/grade-writing", headers=AUTH,
        json=_writing_payload("testdaf_digital", "schreiben_1"),
    )
    assert r.status_code == 200
    assert r.json()["scoreValue"] == 40


def test_grade_writing_unsupported_profile_rejected(client: TestClient) -> None:
    r = client.post(
        "/german-exam/grade-writing", headers=AUTH,
        json=_writing_payload("not_a_real_profile", "schreiben_1"),
    )
    assert r.status_code == 400


def test_grade_writing_unsupported_task_type_rejected(client: TestClient) -> None:
    """goethe_c1's schreiben_1 (forum_discussion_post) is a real, registered
    part — but its task type is deliberately not in the gradable set yet, so
    it must still 501, exactly like before this change."""
    r = client.post(
        "/german-exam/grade-writing", headers=AUTH,
        json=_writing_payload("goethe_c1", "schreiben_1"),
    )
    assert r.status_code == 501


def test_grade_writing_requires_token(client: TestClient) -> None:
    r = client.post("/german-exam/grade-writing", json=_writing_payload("telc_c1_hochschule", "schreiben_1"))
    assert r.status_code == 401


# ── /german-exam/speaking ────────────────────────────────────────────────────


def _speaking_payload(profile_id: str, **overrides) -> dict:
    payload = {
        "userId": USER,
        "profileId": profile_id,
        "sessionId": "session-1234567890",
        "action": "transcribe",
        "stage": "presentation",
        "audioBase64": "",
        "mimeType": "audio/webm",
        "tasks": {},
        "selectedTopicId": "",
        "turns": [],
    }
    payload.update(overrides)
    return payload


def test_speaking_telc_accepted(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """action=transcribe is the cheapest path through the endpoint body once
    past the new profile gate; transcribe() itself is monkeypatched too so no
    provider call happens."""
    from app.routers import german_exam as router_mod

    calls: list[tuple] = []
    monkeypatch.setattr(router_mod.speaking_practice, "transcribe", lambda *a, **kw: calls.append(a) or {"role": "learner"})
    r = client.post(
        "/german-exam/speaking", headers=AUTH,
        json=_speaking_payload("telc_c1_hochschule", audioBase64="eA=="),
    )
    assert r.status_code == 200
    assert calls  # transcribe was actually reached, i.e. the profile gate let telc through


def test_speaking_testdaf_not_yet_supported(client: TestClient) -> None:
    """testdaf_digital is a real, registered profile, but the shared speaking
    dispatch is still telc_c1_hochschule-specific end to end (see
    GRADABLE_SPEAKING_PROFILE_IDS) — this must keep 501ing, not silently grade
    TestDaF answers against telc's rubric."""
    r = client.post(
        "/german-exam/speaking", headers=AUTH,
        json=_speaking_payload("testdaf_digital", audioBase64="eA=="),
    )
    assert r.status_code == 501


def test_speaking_unsupported_profile_rejected(client: TestClient) -> None:
    r = client.post(
        "/german-exam/speaking", headers=AUTH,
        json=_speaking_payload("not_a_real_profile"),
    )
    assert r.status_code == 400


def test_speaking_requires_token(client: TestClient) -> None:
    r = client.post("/german-exam/speaking", json=_speaking_payload("telc_c1_hochschule"))
    assert r.status_code == 401

"""Router-level regression tests for POST /german-exam/grade-writing,
POST /german-exam/speaking, and POST /german-exam/grade-speaking-recording.

Covers the profile/task-driven gates that replaced the old TELC-only
hardcodes (part.task_type != "choice_long_form_writing" for writing;
profileId: Literal["telc_c1_hochschule"] for speaking): TELC keeps behaving
exactly as before, TestDaF's and Goethe's writing task types are now admitted
through to the shared grading adapter, and every unsupported profile/task
combination still comes back as a clean 4xx/501 — never a crash, never
silent success.

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


def _testdaf_task() -> dict:
    return {"schemaVersion": "productive-task-v1", "id": "t1", "prompt": "Schreiben Sie einen Text.", "sources": []}


def test_grade_writing_testdaf_accepted(client: TestClient) -> None:
    """A real TestDaF writing task is a productive-task-v1 object, not a TELC
    two-statement topic. The route must accept exactly that shape."""
    payload = _writing_payload("testdaf_digital", "schreiben_1", task=_testdaf_task())
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
    assert r.status_code == 200
    assert r.json()["scoreValue"] == 40


def test_grade_writing_testdaf_requires_task(client: TestClient) -> None:
    payload = _writing_payload("testdaf_digital", "schreiben_1")
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
    assert r.status_code == 400


def test_grade_writing_testdaf_rejects_model_answer_task(client: TestClient) -> None:
    payload = _writing_payload("testdaf_digital", "schreiben_1", task={**_testdaf_task(), "modelAnswer": "x"})
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
    assert r.status_code == 400


def test_grade_writing_telc_still_requires_matching_topic(client: TestClient) -> None:
    payload = _writing_payload("telc_c1_hochschule", "schreiben_1")
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
    assert r.status_code == 400


def test_grade_writing_unsupported_profile_rejected(client: TestClient) -> None:
    r = client.post(
        "/german-exam/grade-writing", headers=AUTH,
        json=_writing_payload("not_a_real_profile", "schreiben_1"),
    )
    assert r.status_code == 400


def test_grade_writing_goethe_schreiben1_accepted(client: TestClient) -> None:
    """Goethe's schreiben_1 (forum_discussion_post) is a productive-task-v1
    shape, exactly like TestDaF — not TELC's topic-choice shape."""
    payload = _writing_payload("goethe_c1", "schreiben_1", task=_testdaf_task())
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
    assert r.status_code == 200
    assert r.json()["scoreValue"] == 40


def test_grade_writing_goethe_schreiben2_accepted(client: TestClient) -> None:
    payload = _writing_payload("goethe_c1", "schreiben_2", task=_testdaf_task())
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
    assert r.status_code == 200
    assert r.json()["scoreValue"] == 40


def test_grade_writing_unsupported_task_type_rejected(client: TestClient) -> None:
    """DSH's tp_1 (dsh_tp_chart_based_argumentation) is a real, registered
    writing-module part that already declares grading_dimensions — but DSH is
    deliberately excluded from GRADABLE_WRITING_PROFILE_IDS (no DSH content/
    grading pipeline exists yet), so it must still 501, never silently grade
    against another exam's rubric."""
    payload = _writing_payload("dsh", "tp_1", task=_testdaf_task())
    payload.pop("selectedTopic")
    r = client.post("/german-exam/grade-writing", headers=AUTH, json=payload)
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


# ── /german-exam/grade-speaking-recording ─────────────────────────────────
# A separate endpoint from /german-exam/speaking above: TestDaF's 7 independent
# single-recording tasks go through the generic grade_productive()/SPEAKING_TYPES
# contract (german_exam_testdaf_speaking.py), never telc's interactive partner-
# dialogue dispatch — the two request shapes are incompatible (see that module's
# docstring). grade_testdaf_speaking_recording itself is monkeypatched here (it
# has its own full unit coverage in test_german_exam_testdaf_speaking_grader.py);
# this file only proves the router's gates.


def _speaking_recording_payload(profile_id: str, part_id: str, **overrides) -> dict:
    payload = {
        "userId": USER,
        "profileId": profile_id,
        "partId": part_id,
        "task": {"schemaVersion": "productive-task-v1", "id": "t1", "prompt": "Geben Sie Ihrem Freund einen Rat.", "sources": []},
        "audioBase64": "eA==",
        "mimeType": "audio/webm",
        "durationSeconds": 10.0,
    }
    payload.update(overrides)
    return payload


def test_grade_speaking_recording_testdaf_sprechen1_accepted(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.routers import german_exam as router_mod

    monkeypatch.setattr(router_mod.testdaf_speaking, "grade_testdaf_speaking_recording", lambda *a, **kw: {
        "kind": "practice_feedback", "dimensions": [{"id": "task_fulfilment", "feedback": "Gut.", "evidence": []}],
    })
    r = client.post(
        "/german-exam/grade-speaking-recording", headers=AUTH,
        json=_speaking_recording_payload("testdaf_digital", "sprechen_1"),
    )
    assert r.status_code == 200
    assert r.json()["kind"] == "practice_feedback"


def test_grade_speaking_recording_rejects_model_answer_task(client: TestClient) -> None:
    payload = _speaking_recording_payload(
        "testdaf_digital", "sprechen_1",
        task={"schemaVersion": "productive-task-v1", "id": "t1", "prompt": "x", "sources": [], "modelAnswer": "leaked"},
    )
    r = client.post("/german-exam/grade-speaking-recording", headers=AUTH, json=payload)
    assert r.status_code == 400


def test_grade_speaking_recording_unsupported_profile_rejected(client: TestClient) -> None:
    r = client.post(
        "/german-exam/grade-speaking-recording", headers=AUTH,
        json=_speaking_recording_payload("not_a_real_profile", "sprechen_1"),
    )
    assert r.status_code == 400


def test_grade_speaking_recording_telc_rejected_wrong_architecture(client: TestClient) -> None:
    """TELC's sprechen_1 is presentation_summary_followup — the interactive
    partner-dialogue shape handled by /german-exam/speaking above, not SPEAKING_TYPES.
    It must 501 here, never silently grade through the wrong pipeline."""
    r = client.post(
        "/german-exam/grade-speaking-recording", headers=AUTH,
        json=_speaking_recording_payload("telc_c1_hochschule", "sprechen_1"),
    )
    assert r.status_code == 501


def test_grade_speaking_recording_dsh_rejected_not_in_allowlist(client: TestClient) -> None:
    """DSH's sprechen_1 is its own oral task type (TASK_TYPE_ORAL), not a
    SPEAKING_TYPES productive task — stays 501 until DSH has a real grader."""
    r = client.post(
        "/german-exam/grade-speaking-recording", headers=AUTH,
        json=_speaking_recording_payload("dsh", "sprechen_1"),
    )
    assert r.status_code == 501


def test_grade_speaking_recording_requires_token(client: TestClient) -> None:
    r = client.post(
        "/german-exam/grade-speaking-recording",
        json=_speaking_recording_payload("testdaf_digital", "sprechen_1"),
    )
    assert r.status_code == 401

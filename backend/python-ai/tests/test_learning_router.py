"""Router tests for the Learning Agent endpoints (Phase 1)."""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

_OWNER = "22222222-2222-4222-8222-222222222222"
_COURSE = "uc_123"


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"
    from app.config import get_settings  # noqa: WPS433
    get_settings.cache_clear()


def _owner_sb(count: int = 1) -> MagicMock:
    """Fake sb whose owner-count head query returns ``count``."""
    sb = MagicMock()
    chain = sb.table.return_value.select.return_value.eq.return_value.eq.return_value
    chain.execute.return_value = MagicMock(count=count)
    return sb


@pytest.fixture()
def client(monkeypatch) -> TestClient:
    monkeypatch.setattr("app.routers.learning.get_supabase", lambda: _owner_sb(1))
    monkeypatch.setattr("app.routers.learning.build_course_topic_map", lambda u, c: None)
    monkeypatch.setattr(
        "app.routers.learning.get_course_topic_map",
        lambda u, c: [{"name": "Circular Motion", "importance": "high", "chunk_count": 5}],
    )
    monkeypatch.setattr(
        "app.routers.learning.get_next_best_action",
        lambda u, c: {"courseId": c, "weakTopics": ["Friction"], "topicCount": 3,
                      "actions": [{"type": "deep_learn", "topic": "Friction"}]},
    )
    from app.main import app  # noqa: WPS433
    return TestClient(app)


def test_requires_internal_token(client: TestClient) -> None:
    r = client.post("/course-topic-map", json={"userId": _OWNER, "courseId": _COURSE})
    assert r.status_code == 401


def test_read_topic_map(client: TestClient) -> None:
    r = client.post("/course-topic-map", headers={"X-Internal-Token": "test-token"},
                    json={"userId": _OWNER, "courseId": _COURSE})
    assert r.status_code == 200
    body = r.json()
    assert body["courseId"] == _COURSE
    assert body["topics"][0]["name"] == "Circular Motion"


def test_generate_topic_map(client: TestClient) -> None:
    r = client.post("/course-topic-map/generate", headers={"X-Internal-Token": "test-token"},
                    json={"userId": _OWNER, "courseId": _COURSE})
    assert r.status_code == 200
    assert r.json()["status"] == "building"


def test_next_action(client: TestClient) -> None:
    r = client.post("/learning/next-action", headers={"X-Internal-Token": "test-token"},
                    json={"userId": _OWNER, "courseId": _COURSE})
    assert r.status_code == 200
    body = r.json()
    assert body["weakTopics"] == ["Friction"]
    assert body["actions"][0]["topic"] == "Friction"


def test_unknown_course_404(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr("app.routers.learning.get_supabase", lambda: _owner_sb(0))
    r = client.post("/course-topic-map", headers={"X-Internal-Token": "test-token"},
                    json={"userId": _OWNER, "courseId": "uc_not_mine"})
    assert r.status_code == 404

"""Phase 1 smoke tests — no Supabase or OpenAI calls required.

Each test stubs out env vars so Settings() succeeds without real secrets.
"""

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub-service-role-key")
    os.environ.setdefault("OPENAI_API_KEY", "stub-openai-key")
    os.environ.setdefault("INTERNAL_SECRET", "stub-internal-token")
    # Clear the cached settings so the stubbed env is picked up.
    from app.config import get_settings  # noqa: WPS433

    get_settings.cache_clear()


@pytest.fixture()
def client() -> TestClient:
    from app.main import app  # noqa: WPS433

    return TestClient(app)


def test_health_unauthenticated(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "minallo-ai"


def test_db_smoke_requires_internal_token(client: TestClient) -> None:
    r = client.get("/internal/db-smoke")
    assert r.status_code == 401


def test_db_smoke_rejects_wrong_internal_token(client: TestClient) -> None:
    r = client.get("/internal/db-smoke", headers={"X-Internal-Token": "wrong"})
    assert r.status_code == 401


def test_metrics_requires_internal_token(client: TestClient) -> None:
    assert client.get("/internal/metrics").status_code == 401


def test_metrics_reports_threadpool_and_fanout(client: TestClient) -> None:
    # Read the live configured token rather than hardcoding it: other test
    # modules mutate INTERNAL_SECRET + clear the settings cache, so the value
    # isn't fixed across a full-suite run.
    from app.config import get_settings  # noqa: WPS433

    token = get_settings().ai_service_internal_token
    r = client.get("/internal/metrics", headers={"X-Internal-Token": token})
    assert r.status_code == 200
    body = r.json()
    assert body["threadpool"]["total"] >= 1
    assert body["threadpool"]["borrowed"] >= 0
    assert body["llmFanout"]["limit"] >= 1
    assert body["llmFanout"]["in_use"] >= 0

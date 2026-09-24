"""Router tests for /document-review-pages and /correct-document-page.

The Supabase client and the indexing service functions are stubbed so no
real Supabase / OpenAI calls happen.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

_DOC_ID = "11111111-1111-4111-8111-111111111111"
_OWNER = "22222222-2222-4222-8222-222222222222"
_OTHER = "33333333-3333-4333-8333-333333333333"


@pytest.fixture(scope="module", autouse=True)
def _stub_env() -> None:
    os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
    os.environ.setdefault("OPENAI_API_KEY", "stub")
    os.environ["INTERNAL_SECRET"] = "test-token"

    from app.config import get_settings  # noqa: WPS433
    get_settings.cache_clear()


def _fake_sb(owner: str = _OWNER) -> MagicMock:
    sb = MagicMock()
    chain = sb.table.return_value.select.return_value.eq.return_value.limit.return_value
    chain.execute.return_value = MagicMock(data=[{
        "id": _DOC_ID,
        "user_id": owner,
        "course_id": "course-1",
    }])
    return sb


@pytest.fixture()
def client(monkeypatch) -> TestClient:
    fake = _fake_sb()
    monkeypatch.setattr("app.routers.corrections.get_supabase", lambda: fake)
    monkeypatch.setattr(
        "app.routers.corrections.list_review_pages",
        lambda doc_id: [
            {"pageNumber": 3, "provider": "openai_handwriting", "mode": "handwriting",
             "confidence": 0.71, "unclearCount": 2, "text": "F = m a [unclear]"},
        ],
    )
    # The correction + reindex must not run for real in unit tests.
    monkeypatch.setattr(
        "app.routers.corrections.correct_document_page", lambda *a, **kw: 0
    )
    monkeypatch.setattr(
        "app.routers.corrections.reindex_chunks_from_pages", lambda *a, **kw: None
    )

    from app.main import app  # noqa: WPS433
    return TestClient(app)


def test_review_pages_requires_internal_token(client: TestClient) -> None:
    r = client.post("/document-review-pages", json={"userId": _OWNER, "documentId": _DOC_ID})
    assert r.status_code == 401


def test_review_pages_returns_flagged(client: TestClient) -> None:
    r = client.post(
        "/document-review-pages",
        headers={"X-Internal-Token": "test-token"},
        json={"userId": _OWNER, "documentId": _DOC_ID},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["documentId"] == _DOC_ID
    assert len(body["pages"]) == 1
    assert body["pages"][0]["pageNumber"] == 3
    assert body["pages"][0]["mode"] == "handwriting"


def test_review_pages_rejects_wrong_owner(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr("app.routers.corrections.get_supabase", lambda: _fake_sb(owner=_OTHER))
    r = client.post(
        "/document-review-pages",
        headers={"X-Internal-Token": "test-token"},
        json={"userId": _OWNER, "documentId": _DOC_ID},
    )
    assert r.status_code == 404


def test_correct_page_happy_path(client: TestClient) -> None:
    r = client.post(
        "/correct-document-page",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": _OWNER, "courseId": "course-1", "documentId": _DOC_ID,
            "pageNumber": 3, "correctedText": "F = m \\cdot a",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "accepted"
    assert body["pageNumber"] == 3


def test_correct_page_rejects_empty_text(client: TestClient) -> None:
    r = client.post(
        "/correct-document-page",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": _OWNER, "courseId": "course-1", "documentId": _DOC_ID,
            "pageNumber": 3, "correctedText": "   ",
        },
    )
    assert r.status_code == 400


def test_correct_page_rejects_course_mismatch(client: TestClient) -> None:
    r = client.post(
        "/correct-document-page",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": _OWNER, "courseId": "wrong-course", "documentId": _DOC_ID,
            "pageNumber": 3, "correctedText": "ok",
        },
    )
    assert r.status_code == 404


def test_correct_page_rejects_bad_page_number(client: TestClient) -> None:
    r = client.post(
        "/correct-document-page",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": _OWNER, "courseId": "course-1", "documentId": _DOC_ID,
            "pageNumber": 0, "correctedText": "ok",
        },
    )
    assert r.status_code == 422  # pydantic ge=1

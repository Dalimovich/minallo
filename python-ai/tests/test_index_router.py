"""Router tests for /index-document and /document-index-status.

We stub the Supabase client and the index_document service so no real
Supabase / OpenAI calls happen.
"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


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
    """Build a TestClient with the Supabase client patched out."""

    def _fake_sb(doc_user_id: str = "22222222-2222-4222-8222-222222222222") -> MagicMock:
        sb = MagicMock()
        # `.select(...).eq("id", X).limit(1).execute()` chain
        chain = sb.table.return_value.select.return_value.eq.return_value.limit.return_value
        chain.execute.return_value = MagicMock(data=[{
            "id": "11111111-1111-4111-8111-111111111111",
            "user_id": doc_user_id,
            "course_id": "course-1",
            "storage_path": "22222222-2222-4222-8222-222222222222/course-1/abc.pdf",
            "processing_status": "ready",
            "chunk_count": 5,
            "page_count": 12,
            "indexed_at": "2026-05-12T00:00:00+00:00",
            "processing_error": None,
        }])
        return sb

    fake = _fake_sb()
    monkeypatch.setattr("app.routers.index.get_supabase", lambda: fake)
    monkeypatch.setattr("app.services.indexing.get_supabase", lambda: fake)
    # Don't actually run the background indexer in unit tests.
    monkeypatch.setattr("app.routers.index.index_document", lambda *a, **kw: None)

    from app.main import app  # noqa: WPS433
    return TestClient(app)


def test_index_document_requires_internal_token(client: TestClient) -> None:
    r = client.post(
        "/index-document",
        json={
            "userId": "22222222-2222-4222-8222-222222222222",
            "courseId": "course-1",
            "documentId": "11111111-1111-4111-8111-111111111111",
            "storagePath": "22222222-2222-4222-8222-222222222222/course-1/abc.pdf",
        },
    )
    assert r.status_code == 401


def test_index_document_owner_match_returns_200(client: TestClient) -> None:
    r = client.post(
        "/index-document",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": "22222222-2222-4222-8222-222222222222",
            "courseId": "course-1",
            "documentId": "11111111-1111-4111-8111-111111111111",
            "storagePath": "22222222-2222-4222-8222-222222222222/course-1/abc.pdf",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["documentId"] == "11111111-1111-4111-8111-111111111111"
    # Already-indexed snapshot maps to "indexed" — but the router can
    # also rewrite to "indexing" if the previous status was a failure
    # state. Both are acceptable here.
    assert body["status"] in ("indexed", "indexing")


def test_index_document_rejects_wrong_owner(client: TestClient, monkeypatch) -> None:
    # Re-stub get_supabase so the document is owned by someone else.
    fake = MagicMock()
    chain = fake.table.return_value.select.return_value.eq.return_value.limit.return_value
    chain.execute.return_value = MagicMock(data=[{
        "id": "11111111-1111-4111-8111-111111111111",
        "user_id": "33333333-3333-4333-8333-333333333333",
        "course_id": "course-1",
        "storage_path": "x/y/z.pdf",
        "processing_status": "ready",
    }])
    monkeypatch.setattr("app.routers.index.get_supabase", lambda: fake)

    r = client.post(
        "/index-document",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": "22222222-2222-4222-8222-222222222222",
            "courseId": "course-1",
            "documentId": "11111111-1111-4111-8111-111111111111",
        },
    )
    # Owner mismatch — 404 (we deliberately don't 403 to avoid leaking existence)
    assert r.status_code == 404


def test_status_endpoint(client: TestClient) -> None:
    r = client.get(
        "/document-index-status",
        headers={"X-Internal-Token": "test-token"},
        params={"documentId": "11111111-1111-4111-8111-111111111111", "userId": "22222222-2222-4222-8222-222222222222"},
    )
    assert r.status_code == 200
    body: dict[str, Any] = r.json()
    assert body["documentId"] == "11111111-1111-4111-8111-111111111111"
    assert body["status"] == "indexed"
    assert body["chunkCount"] == 5
    assert body["pageCount"] == 12

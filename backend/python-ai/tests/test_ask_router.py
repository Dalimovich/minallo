"""Router tests for /ask and /retrieve-context.

Supabase + OpenAI calls are mocked; we just verify the routing/auth/owner
checks and the cache short-circuit.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

OWNER  = "22222222-2222-4222-8222-222222222222"
DOC_A  = "11111111-1111-4111-8111-111111111111"
COURSE = "course-abc"


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
    # ── Supabase mock: owner-check returns the doc as owned by OWNER. ───────
    sb = MagicMock()
    docs_select = sb.table.return_value.select.return_value.in_.return_value
    docs_select.execute.return_value = MagicMock(data=[{
        "id": DOC_A,
        "user_id": OWNER,
        "course_id": COURSE,
        "file_name": "file-a.pdf",
    }])

    monkeypatch.setattr("app.routers.ask.get_supabase", lambda: sb)

    # Mock retrieval to a single strong-similarity chunk so /ask hits the
    # "strong" prompt branch without calling pgvector.
    from app.services.retrieval import RetrievedChunk
    monkeypatch.setattr(
        "app.routers.ask.retrieve_chunks",
        lambda **kw: [RetrievedChunk(
            chunk_id="c1", document_id=DOC_A,
            page_start=1, page_end=2,
            text="Newton's second law states F = m * a.",
            score=0.6, similarity=0.55, chunk_type="definition", section_title="Newton's Laws",
        )],
    )

    # Skip cache lookups; force regeneration path. (The version-hash helper was
    # renamed document→course when caching moved to a whole-course version hash.)
    monkeypatch.setattr("app.routers.ask.fetch_course_version_hash", lambda *a, **kw: "vh1")
    monkeypatch.setattr("app.routers.ask.lookup_answer", lambda **kw: None)
    monkeypatch.setattr("app.routers.ask.save_answer", lambda **kw: None)

    # Mock the generator so no OpenAI call happens.
    monkeypatch.setattr(
        "app.routers.ask.generate_answer",
        lambda **kw: {
            "answer": "F = m * a, see file-a.pdf p.1-2.",
            "retrievalMode": "strong",
            "groundedSources": [{"fileName": "file-a.pdf", "pageStart": 1, "pageEnd": 2,
                                 "sectionTitle": "Newton's Laws", "chunkType": "definition", "similarity": 0.55}],
            "model": "gpt-4o-mini",
            "promptTokens": 100,
            "completionTokens": 30,
        },
    )

    from app.main import app  # noqa: WPS433
    return TestClient(app)


def test_ask_requires_internal_token(client: TestClient) -> None:
    r = client.post("/ask", json={
        "userId": OWNER, "courseId": COURSE,
        "documentIds": [DOC_A], "question": "What is Newton's second law?",
    })
    assert r.status_code == 401


def test_ask_grounded_answer(client: TestClient) -> None:
    r = client.post(
        "/ask",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER, "courseId": COURSE,
            "documentIds": [DOC_A],
            "question": "What is Newton's second law?",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["retrievalMode"] == "strong"
    assert body["cacheHit"] is False
    assert body["groundedSources"]
    assert body["groundedSources"][0]["fileName"] == "file-a.pdf"


def test_ask_rejects_bad_uuid(client: TestClient) -> None:
    r = client.post(
        "/ask",
        headers={"X-Internal-Token": "test-token"},
        json={"userId": "not-a-uuid", "courseId": COURSE, "question": "hi"},
    )
    assert r.status_code == 400


def test_ask_generation_failure_does_not_disclose_provider_error(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_generation(**_kwargs):
        raise RuntimeError("provider api_key=top-secret request details")

    monkeypatch.setattr("app.routers.ask.generate_answer", fail_generation)

    r = client.post(
        "/ask",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER,
            "courseId": COURSE,
            "question": "How do I use Minallo?",
        },
    )

    assert r.status_code == 502
    assert r.json() == {
        "detail": "Answer generation is temporarily unavailable. Please try again."
    }
    assert "top-secret" not in r.text


class _HealthQuery:
    """Chainable stub mimicking supabase-py's fluent query builder — copied
    from test_document_health.py's fixture pattern for the stale-metadata
    incident (processing_status='ready' + non-zero cached chunk_count but
    zero live document_chunks rows under the active revision)."""

    def __init__(self, data=None, count=None):
        self._data = data
        self._count = count

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        from types import SimpleNamespace
        return SimpleNamespace(data=self._data, count=self._count)


class _StaleMetadataHealthSupabase:
    """Reports DOC_A as processing_status='ready'/chunk_count=23 in the
    cached `documents` row, but zero live `document_chunks` rows under its
    `active_index_revision` — the exact 2026-08-31 incident class
    validate_active_document_index exists to catch."""

    def table(self, name: str):
        if name == "documents":
            return _HealthQuery(data=[{
                "id": DOC_A, "processing_status": "ready",
                "page_count": 2, "chunk_count": 23,
                "active_index_revision": "r1", "index_revision_status": "ready",
            }])
        if name == "document_chunks":
            return _HealthQuery(count=0)
        if name == "document_pages":
            return _HealthQuery(count=2)
        if name == "document_page_manifests":
            return _HealthQuery(data=[
                {"page_number": 1, "source_page_id": "r1:1",
                 "required_for_processing": True, "status": "indexed", "exclusion_reason": None},
                {"page_number": 2, "source_page_id": "r1:2",
                 "required_for_processing": True, "status": "indexed", "exclusion_reason": None},
            ])
        raise AssertionError(f"unexpected table: {name}")


def test_ask_blocks_when_selected_document_index_is_corrupt(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """/ask must gate on document_health the same way /ask-stream already
    does — a document sitting at processing_status='ready' with a stale
    non-zero chunk_count but zero live chunks must never be silently
    retrieved against; it must surface a typed DOCUMENT_INDEX_CORRUPT error
    instead of a degraded/empty answer."""
    monkeypatch.setattr(
        "app.services.document_health.get_supabase",
        lambda: _StaleMetadataHealthSupabase(),
    )

    r = client.post(
        "/ask",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER, "courseId": COURSE,
            "documentIds": [DOC_A],
            "question": "What is Newton's second law?",
        },
    )
    assert r.status_code == 409
    body = r.json()["detail"]
    assert body["code"] == "DOCUMENT_INDEX_CORRUPT"
    assert body["error"] is True
    assert body["metadata"]["documentId"] == DOC_A


def test_retrieve_context_blocks_when_selected_document_index_is_corrupt(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.services.document_health.get_supabase",
        lambda: _StaleMetadataHealthSupabase(),
    )

    r = client.post(
        "/retrieve-context",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER, "courseId": COURSE,
            "documentIds": [DOC_A],
            "query": "Newton's second law",
        },
    )
    assert r.status_code == 409
    body = r.json()["detail"]
    assert body["code"] == "DOCUMENT_INDEX_CORRUPT"


def test_retrieve_context_returns_chunks(client: TestClient) -> None:
    r = client.post(
        "/retrieve-context",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER, "courseId": COURSE,
            "documentIds": [DOC_A],
            "query": "Newton's second law",
            "topK": 5,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["chunks"]) == 1
    assert body["chunks"][0]["documentId"] == DOC_A

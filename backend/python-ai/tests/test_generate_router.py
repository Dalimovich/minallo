"""Router-level tests for /generate-quiz, /generate-flashcards, /generate-notes."""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

OWNER  = "22222222-2222-4222-8222-222222222222"
DOC_A  = "11111111-1111-4111-8111-111111111111"
DOC_B  = "33333333-3333-4333-8333-333333333333"
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
    sb = MagicMock()
    chain = sb.table.return_value.select.return_value.in_.return_value
    chain.execute.return_value = MagicMock(data=[{
        "id": DOC_A, "user_id": OWNER, "course_id": COURSE, "file_name": "f.pdf",
    }])
    monkeypatch.setattr("app.routers.generate.get_supabase", lambda: sb)

    monkeypatch.setattr(
        "app.routers.generate.generate_quiz",
        lambda **kw: {
            "requestedCount": kw["requested_count"], "actualCount": kw["requested_count"],
            "questions": [{"type": "mcq", "question": "Q1", "options": {"A": "a", "B": "b", "C": "c", "D": "d"},
                           "answer": "A", "explanation": "", "difficulty": "easy", "source": "f.pdf, p.1"}],
            "groundedSources": [{"fileName": "f.pdf", "pageStart": 1, "pageEnd": 1, "chunkId": "c1"}],
            "model": "gpt-4o-mini", "promptTokens": 100, "completionTokens": 30,
        },
    )
    monkeypatch.setattr("app.routers.generate.save_quiz_set", lambda **kw: "set-1")

    monkeypatch.setattr(
        "app.routers.generate.generate_flashcards",
        lambda **kw: {
            "requestedCount": kw["requested_count"], "actualCount": kw["requested_count"],
            "cards": [{"front": "Define velocity", "back": "Rate of change of displacement", "tags": ["definition"],
                       "difficulty": "easy", "source": "f.pdf, p.1"}],
            "groundedSources": [{"fileName": "f.pdf", "pageStart": 1, "pageEnd": 1, "chunkId": "c1"}],
            "model": "gpt-4o-mini", "promptTokens": 50, "completionTokens": 20,
        },
    )
    monkeypatch.setattr("app.routers.generate.save_flashcard_set", lambda **kw: "set-2")

    monkeypatch.setattr(
        "app.routers.generate.generate_notes",
        lambda **kw: {
            "text": "## Overview\nA short note.", "pageCount": 9, "lengthCue": "concise",
            "groundedSources": [{"fileName": "f.pdf", "pageStart": 1, "pageEnd": 1, "chunkId": "c1"}],
            "model": "gpt-4o-mini", "promptTokens": 200, "completionTokens": 100,
        },
    )
    monkeypatch.setattr("app.routers.generate.save_note", lambda **kw: "note-1")

    from app.main import app  # noqa: WPS433
    return TestClient(app)


def test_generate_quiz_requires_token(client: TestClient) -> None:
    r = client.post("/generate-quiz", json={
        "userId": OWNER, "courseId": COURSE, "documentIds": [DOC_A], "requestedCount": 1,
    })
    assert r.status_code == 401


def test_generate_quiz_success(client: TestClient) -> None:
    r = client.post(
        "/generate-quiz",
        headers={"X-Internal-Token": "test-token"},
        json={"userId": OWNER, "courseId": COURSE, "documentIds": [DOC_A], "requestedCount": 1},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["actualCount"] == 1
    assert body["studySetId"] == "set-1"
    assert body["groundedSources"][0]["fileName"] == "f.pdf"


def test_generate_flashcards_success(client: TestClient) -> None:
    r = client.post(
        "/generate-flashcards",
        headers={"X-Internal-Token": "test-token"},
        json={"userId": OWNER, "courseId": COURSE, "documentIds": [DOC_A], "requestedCount": 1},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["actualCount"] == 1
    assert body["studySetId"] == "set-2"
    assert body["groundedSources"][0]["fileName"] == "f.pdf"


def test_generate_notes_success(client: TestClient) -> None:
    r = client.post(
        "/generate-notes",
        headers={"X-Internal-Token": "test-token"},
        json={"userId": OWNER, "courseId": COURSE, "documentIds": [DOC_A]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["text"].startswith("## Overview")
    assert body["noteId"] == "note-1"


# ── Stage 1: option forwarding ───────────────────────────────────────────────


def test_quiz_forwards_seen_items_and_language(client: TestClient, monkeypatch) -> None:
    captured: dict = {}

    def cap(**kw):
        captured.update(kw)
        return {"requestedCount": 1, "actualCount": 0, "questions": [], "groundedSources": []}

    monkeypatch.setattr("app.routers.generate.generate_quiz", cap)
    r = client.post(
        "/generate-quiz",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER, "courseId": COURSE, "documentIds": [DOC_A], "requestedCount": 1,
            "seenItems": ["old question 1"], "language": "en",
        },
    )
    assert r.status_code == 200
    assert captured["seen_items"] == ["old question 1"]
    assert captured["language"] == "en"


def test_flashcards_forwards_difficulty_language_seen(client: TestClient, monkeypatch) -> None:
    captured: dict = {}

    def cap(**kw):
        captured.update(kw)
        return {"requestedCount": 1, "actualCount": 0, "cards": [], "groundedSources": []}

    monkeypatch.setattr("app.routers.generate.generate_flashcards", cap)
    r = client.post(
        "/generate-flashcards",
        headers={"X-Internal-Token": "test-token"},
        json={
            "userId": OWNER, "courseId": COURSE, "documentIds": [DOC_A], "requestedCount": 1,
            "difficulty": "hard", "language": "de", "seenItems": ["front a"],
        },
    )
    assert r.status_code == 200
    assert captured["difficulty"] == "hard"
    assert captured["language"] == "de"
    assert captured["seen_items"] == ["front a"]


# ── Stage 1: backend-authoritative ready-document resolver ───────────────────


def _sb_with(explicit_rows=None, ready_rows=None) -> MagicMock:
    sb = MagicMock()
    sb.table.return_value.select.return_value.in_.return_value.execute.return_value = MagicMock(
        data=explicit_rows or []
    )
    sb.table.return_value.select.return_value.eq.return_value.eq.return_value.eq.return_value.limit.return_value.execute.return_value = MagicMock(  # noqa: E501
        data=ready_rows or []
    )
    return sb


def test_resolver_filters_not_ready(monkeypatch) -> None:
    from app.routers import generate as gen

    rows = [
        {"id": DOC_A, "user_id": OWNER, "course_id": COURSE, "file_name": "a.pdf", "processing_status": "ready"},
        {"id": DOC_B, "user_id": OWNER, "course_id": COURSE, "file_name": "b.pdf", "processing_status": "processing"},
    ]
    monkeypatch.setattr(gen, "get_supabase", lambda: _sb_with(explicit_rows=rows))
    ids, names = gen._resolve_ready_document_ids(OWNER, COURSE, [DOC_A, DOC_B])
    assert ids == [DOC_A]
    assert names == {DOC_A: "a.pdf"}


def test_resolver_rejects_foreign_doc(monkeypatch) -> None:
    from fastapi import HTTPException

    from app.routers import generate as gen

    rows = [{"id": DOC_A, "user_id": "someone-else", "course_id": COURSE, "file_name": "a.pdf", "processing_status": "ready"}]
    monkeypatch.setattr(gen, "get_supabase", lambda: _sb_with(explicit_rows=rows))
    with pytest.raises(HTTPException) as ei:
        gen._resolve_ready_document_ids(OWNER, COURSE, [DOC_A])
    assert ei.value.status_code == 404


def test_resolver_all_files_expands_to_ready(monkeypatch) -> None:
    from app.routers import generate as gen

    rows = [{"id": DOC_A, "file_name": "a.pdf"}, {"id": DOC_B, "file_name": "b.pdf"}]
    monkeypatch.setattr(gen, "get_supabase", lambda: _sb_with(ready_rows=rows))
    ids, names = gen._resolve_ready_document_ids(OWNER, COURSE, None)
    assert ids == [DOC_A, DOC_B]
    assert names[DOC_A] == "a.pdf"

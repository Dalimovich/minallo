"""Configuration defaults that must match the rest of the stack."""

from __future__ import annotations


def test_default_rag_storage_bucket_matches_uploader(monkeypatch) -> None:
    from app.config import get_settings

    monkeypatch.delenv("RAG_STORAGE_BUCKET", raising=False)
    get_settings.cache_clear()
    try:
        assert get_settings().rag_storage_bucket == "course-uploads"
    finally:
        get_settings.cache_clear()

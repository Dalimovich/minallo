"""Internal token auth, including the zero-downtime rotation window."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import auth


def _settings(monkeypatch, current, previous=None):
    monkeypatch.setattr(auth, "get_settings", lambda: SimpleNamespace(
        ai_service_internal_token=current, ai_service_internal_token_previous=previous))


def _check(token):
    return asyncio.run(auth.require_internal_token(token))


def test_current_token_accepted_and_wrong_rejected(monkeypatch):
    _settings(monkeypatch, "new-secret")
    _check("new-secret")
    with pytest.raises(HTTPException) as exc:
        _check("nope")
    assert exc.value.status_code == 401


def test_previous_token_only_accepted_during_a_rotation_window(monkeypatch):
    _settings(monkeypatch, "new-secret", "old-secret")
    _check("old-secret")
    _check("new-secret")
    _settings(monkeypatch, "new-secret", None)  # window closed
    with pytest.raises(HTTPException):
        _check("old-secret")


def test_missing_or_empty_token_is_always_rejected(monkeypatch):
    _settings(monkeypatch, "new-secret", "old-secret")
    for bad in ("", "x"):
        with pytest.raises(HTTPException):
            _check(bad)
    _settings(monkeypatch, "", None)
    with pytest.raises(HTTPException):
        _check("")

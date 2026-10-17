"""Shared registry behaviour (app/services/german_exams/registry.py). Exam-specific
structure is asserted in each exam's own test_german_exam_profile_<exam>.py."""

from __future__ import annotations

import pytest

from app.services.german_exams import GERMAN_EXAM_PROFILES, GermanExamProfileError, get_profile, list_parts, resolve_profile_id


def test_registry_keys_match_profile_ids() -> None:
    for key, profile in GERMAN_EXAM_PROFILES.items():
        assert key == profile.profile_id


def test_unknown_module_raises() -> None:
    with pytest.raises(GermanExamProfileError):
        list_parts("telc_c1_hochschule", "not_a_real_module")


def test_unknown_profile_raises() -> None:
    with pytest.raises(GermanExamProfileError):
        get_profile("does_not_exist")


def test_resolve_profile_id_matches_legacy_level() -> None:
    assert resolve_profile_id("telc", "C1 Hochschule") == "telc_c1_hochschule"


def test_resolve_profile_id_returns_none_when_unmatched() -> None:
    assert resolve_profile_id("telc", "B2") is None
    assert resolve_profile_id("TestDaF", "TDN 4") is None

"""Server-side German learner profile: the AI reads the DB, never the client."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routers import writing_coach as wc_router
from app.services import german_learner_profile as glp
from app.services.german_learner_profile import (
    ALL_PROFILE_LEVELS,
    GERMAN_TEST_LEVELS,
    GermanLearnerProfile,
    format_learner_profile_block,
    learner_profile_fingerprint,
)

UID = "11111111-1111-1111-1111-111111111111"


def _profile(test="telc", level="C1 Hochschule", user_type="learner"):
    return GermanLearnerProfile(
        user_type=user_type, test_family=test, target_level=level,
        exam_profile_id=glp.resolve_profile_id(test, level),
    )


class _FakeSupabase:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return self

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return type("R", (), {"data": self.rows})()


def test_profile_reads_db_and_derives_exam_profile(monkeypatch):
    monkeypatch.setattr(glp, "get_supabase", lambda: _FakeSupabase(
        [{"user_type": "learner", "german_test": "telc", "german_level": "C1 Hochschule"}]))
    p = glp.get_german_learner_profile(UID)
    assert (p.test_family, p.target_level, p.exam_profile_id) == ("telc", "C1 Hochschule", "telc_c1_hochschule")
    assert p.has_target


def test_telc_b2_has_no_exam_profile_but_is_a_valid_target(monkeypatch):
    monkeypatch.setattr(glp, "get_supabase", lambda: _FakeSupabase(
        [{"user_type": "learner", "german_test": "telc", "german_level": "B2"}]))
    p = glp.get_german_learner_profile(UID)
    assert p.exam_profile_id is None
    assert p.has_target and p.target_level == "B2"


def test_unreadable_profile_is_none_not_a_guess(monkeypatch):
    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(glp, "get_supabase", boom)
    assert glp.get_german_learner_profile(UID) is None
    assert glp.get_german_learner_profile("") is None


def test_block_states_test_level_and_exam_profile():
    block = format_learner_profile_block(_profile())
    assert "Test family: telc" in block
    assert "Target level: C1 Hochschule" in block
    assert "telc_c1_hochschule" in block
    assert "B2" not in block


def test_block_absent_for_students_unknown_and_targetless_learners():
    assert format_learner_profile_block(None) == ""
    assert format_learner_profile_block(_profile(user_type="enrolled", test="", level="")) == ""
    assert format_learner_profile_block(_profile(test="", level="")) == ""


def test_fingerprint_changes_with_level_so_cached_answers_do_not_replay():
    assert learner_profile_fingerprint(_profile(level="B2")) != learner_profile_fingerprint(_profile())
    assert learner_profile_fingerprint(None) == ""


def test_catalog_matches_frontend_catalog():
    ts = (Path(__file__).resolve().parents[3] / "frontend/js/features/auth/german-profile.ts").read_text(encoding="utf-8")
    block = re.search(r"GERMAN_TEST_LEVELS[^=]*=\s*\{(.*?)\n\};", ts, re.S).group(1)
    parsed = {}
    for m in re.finditer(r"(\w+):\s*\[([^\]]*)\]", block):
        parsed[m.group(1)] = tuple(re.findall(r"'([^']+)'", m.group(2)))
    assert parsed == GERMAN_TEST_LEVELS


def test_every_profile_ui_level_is_accepted_by_writing_coach():
    from app.services.writing_coach import ALLOWED_LEVELS
    for levels in GERMAN_TEST_LEVELS.values():
        for lvl in levels:
            assert lvl in ALLOWED_LEVELS, lvl
    assert ALL_PROFILE_LEVELS <= ALLOWED_LEVELS


# ── Writing Coach router: server profile beats the client level ─────────────

def _run_router(monkeypatch, profile, client_level="B2"):
    seen = {}
    monkeypatch.setattr(wc_router, "get_german_learner_profile", lambda uid: profile)
    monkeypatch.setattr(wc_router, "fetch_weakness_profile", lambda uid: None)

    def analyse(**kw):
        seen.update(kw)
        raise HTTPException(status_code=299, detail="stop")  # short-circuit after capturing
    monkeypatch.setattr(wc_router, "analyse_writing", analyse)
    req = wc_router.AnalyseRequest(userId=UID, text="Ein Text.", profileLevel=client_level)
    with pytest.raises(HTTPException) as exc:
        wc_router.writing_coach_analyse(req)
    return seen, exc.value


def test_stale_client_b2_but_db_c1_hochschule_grades_at_c1_hochschule(monkeypatch):
    seen, exc = _run_router(monkeypatch, _profile(), client_level="B2")
    assert exc.status_code == 299
    assert seen["profile_level"] == "C1 Hochschule"


def test_exam_specific_profile_level_is_never_rejected(monkeypatch):
    for test, level in (("TestDaF", "TDN 4"), ("DSH", "DSH-2"), ("DSD", "DSD II (C1)")):
        seen, exc = _run_router(monkeypatch, _profile(test=test, level=level), client_level="B2")
        assert exc.status_code == 299, (test, level, exc.detail)
        assert seen["profile_level"] == level


def test_client_sends_nothing_at_all_still_works(monkeypatch):
    seen = {}
    monkeypatch.setattr(wc_router, "get_german_learner_profile", lambda uid: _profile())
    monkeypatch.setattr(wc_router, "fetch_weakness_profile", lambda uid: None)
    monkeypatch.setattr(wc_router, "analyse_writing", lambda **kw: (_ for _ in ()).throw(HTTPException(299, "x")))
    req = wc_router.AnalyseRequest(userId=UID, text="Ein Text.")
    with pytest.raises(HTTPException) as exc:
        wc_router.writing_coach_analyse(req)
    assert exc.value.status_code == 299


def test_unreadable_profile_is_a_retryable_503_not_a_guess(monkeypatch):
    _seen, exc = _run_router(monkeypatch, None, client_level="C1 Hochschule")
    assert exc.status_code == 503


def test_learner_without_target_is_told_to_set_profile(monkeypatch):
    _seen, exc = _run_router(monkeypatch, _profile(test="", level=""), client_level="C1")
    assert exc.status_code == 400
    assert "Profile" in exc.detail


# ── generic /chat: the server injects the learner block ─────────────────────

def test_generic_chat_injects_server_learner_block(monkeypatch):
    from app.services import chat as chat_mod
    from app.services import workspace_context as wsc

    captured = {}

    class _Completions:
        def create(self, **kw):
            captured["messages"] = kw["messages"]
            raise RuntimeError("stop after capture")

    class _Client:
        chat = type("C", (), {"completions": _Completions()})()

    monkeypatch.setattr(chat_mod, "get_openai_client", lambda: _Client())
    monkeypatch.setattr(wsc, "fetch_account_snapshot", lambda uid: None)
    monkeypatch.setattr(glp, "get_german_learner_profile", lambda uid: _profile())
    with pytest.raises(RuntimeError):
        chat_mod.run_chat({
            "userId": UID,
            "messages": [{"role": "user", "content": "Explain Konjunktiv II to me"}],
            # A stale client-side hint must not matter:
            "profileLevel": "B2",
        })
    system = captured["messages"][0]["content"]
    assert "Target level: C1 Hochschule" in system
    assert "Test family: telc" in system


# ── general German practice: level from the server profile ──────────────────

def _run_practice(monkeypatch, profile, **req_kwargs):
    from app.routers import german_practice as gp

    seen = {}
    monkeypatch.setattr(gp, "get_german_learner_profile", lambda uid: profile)
    monkeypatch.setattr(gp, "generate_practice", lambda **kw: seen.update(kw) or {"schema": "german-practice-v1", "items": []})
    req = gp.GeneratePracticeRequest(userId=UID, module="vocabulary", topic="uni", **req_kwargs)
    return seen, gp.generate_practice_endpoint(req)


def test_practice_uses_profile_level_and_ignores_stale_client_level(monkeypatch):
    seen, _ = _run_practice(monkeypatch, _profile(), level="B2")
    assert seen["level"] == "C1 Hochschule"


def test_practice_session_override_is_explicit_and_only_for_that_call(monkeypatch):
    seen, _ = _run_practice(monkeypatch, _profile(), sessionLevelOverride="A2")
    assert seen["level"] == "A2"


def test_practice_exam_specific_profile_level_is_accepted(monkeypatch):
    seen, _ = _run_practice(monkeypatch, _profile(test="TestDaF", level="TDN 4"))
    assert seen["level"] == "TDN 4"


def test_practice_unreadable_profile_is_503(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        _run_practice(monkeypatch, None, level="B2")
    assert exc.value.status_code == 503


@pytest.mark.parametrize("saved", ["telc_c1_hochschule", "goethe_c1", "testdaf_digital", "telc_c1_hochschule"])
def test_saved_variant_is_authoritative_and_loads_manifest(monkeypatch, saved):
    from app.services.german_exams import get_profile, build_manifest
    # Deliberately stale legacy fields must not override an explicit variant.
    row = {"user_type": "learner", "german_test": "telc", "german_level": "B2", "german_exam_profile_id": saved}
    monkeypatch.setattr(glp, "get_supabase", lambda: _FakeSupabase([row]))
    resolved = glp.get_german_learner_profile(UID)
    assert build_manifest(get_profile(resolved.exam_profile_id))["profileId"] == saved


def test_unknown_saved_variant_does_not_fall_back(monkeypatch):
    row = {"user_type": "learner", "german_test": "telc", "german_level": "C1 Hochschule", "german_exam_profile_id": "unknown"}
    monkeypatch.setattr(glp, "get_supabase", lambda: _FakeSupabase([row]))
    assert glp.get_german_learner_profile(UID).exam_profile_id is None

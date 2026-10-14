"""Regression coverage for supabase/migrations/20261014_000001_profiles_lock_user_type.sql.

No Docker, psql, or the Supabase CLI is available in this sandboxed test
environment, so the trigger's actual Postgres execution could not be run
here. Two things stand in for that:

1. `_trigger_would_allow` below is a line-for-line Python mirror of the SQL
   function's logic (kept intentionally literal, not "cleaned up", so a
   future edit to one is easy to diff against the other) -- these tests
   exercise every scenario the remediation review asked for and will catch
   a logic regression in the MIRROR. They do not prove the real trigger
   compiles or behaves identically inside Postgres.
2. The structural tests below assert the migration file's actual SQL text
   contains the specific clauses the mirror assumes exist (same convention
   as test_hybrid_document_type_migration.py), so a hand-edit that changes
   the SQL without updating this mirror is caught structurally even though
   it isn't executed.

Before this migration is ever applied to production, run it against a real
(local Supabase CLI / Docker Postgres) instance and re-verify these same
scenarios live -- that step could not be done in this environment and is a
genuine, separate gate, not a formality.
"""
from __future__ import annotations

from pathlib import Path

import pytest

_MIGRATION_PATH = (
    Path(__file__).parents[3] / "supabase" / "migrations" / "20261014_000001_profiles_lock_user_type.sql"
)


def _trigger_would_allow(*, auth_role: str, old_user_type: str | None, new_user_type: str | None) -> bool:
    """Mirrors profiles_lock_user_type()'s exact predicate:

        if auth.role() is distinct from 'authenticated' then return new; end if;
        if coalesce(old.user_type, '') <> '' and new.user_type is distinct from old.user_type then
          raise exception ...;
        end if;
        return new;

    Returns True if the row-level update is ALLOWED (no exception raised).
    """
    if auth_role != "authenticated":
        return True
    old_value = old_user_type if old_user_type is not None else ""
    if old_value != "" and new_user_type != old_user_type:
        return False
    return True


# ── Behavioral mirror of the trigger logic ──────────────────────────────────

def test_onboarding_enrolled_empty_to_value_is_allowed():
    assert _trigger_would_allow(auth_role="authenticated", old_user_type=None, new_user_type="enrolled")


def test_onboarding_learner_empty_to_value_is_allowed():
    # old_user_type as an empty string (not just NULL) must behave the same
    # as NULL -- a prior onboarding attempt could have left it ''.
    assert _trigger_would_allow(auth_role="authenticated", old_user_type="", new_user_type="learner")


def test_unauthorized_role_change_is_blocked():
    assert not _trigger_would_allow(auth_role="authenticated", old_user_type="enrolled", new_user_type="learner")
    assert not _trigger_would_allow(auth_role="authenticated", old_user_type="learner", new_user_type="enrolled")


def test_same_value_update_is_allowed():
    # Re-submitting the same onboarding form, or any upsert that happens to
    # echo back the unchanged value, must not raise.
    assert _trigger_would_allow(auth_role="authenticated", old_user_type="enrolled", new_user_type="enrolled")
    assert _trigger_would_allow(auth_role="authenticated", old_user_type="learner", new_user_type="learner")


def test_unrelated_column_update_leaves_user_type_untouched_and_is_allowed():
    # An UPDATE that only SETs other columns (programme, full_name, ...)
    # carries OLD.user_type forward into NEW.user_type unchanged in Postgres
    # -- modeled here as old == new, the same case as the same-value test,
    # kept separate because it's a distinct real-world path (profile.js
    # editing unrelated fields, not re-submitting onboarding).
    assert _trigger_would_allow(auth_role="authenticated", old_user_type="enrolled", new_user_type="enrolled")


def test_existing_learner_updating_german_test_or_level_is_unaffected():
    # profile.js lets an existing learner re-save german_test/german_level
    # (change target exam/level) without touching user_type at all -- the
    # trigger only ever inspects user_type, so this is just another
    # old==new case, confirmed here under its own name since it's the
    # specific "legitimate learner profile update" scenario called out in
    # the remediation review.
    assert _trigger_would_allow(auth_role="authenticated", old_user_type="learner", new_user_type="learner")


def test_service_role_administrative_path_is_never_blocked():
    # The backend (backend/python-ai/app/supabase_client.py) always connects
    # with the service role key -- auth.role() is only ever 'authenticated'
    # for an ordinary signed-in PostgREST/browser request, never for the
    # trusted backend or an admin/support script using the service key.
    assert _trigger_would_allow(auth_role="service_role", old_user_type="enrolled", new_user_type="learner")
    assert _trigger_would_allow(auth_role="service_role", old_user_type="learner", new_user_type=None)


def test_anon_role_is_also_not_the_authenticated_check():
    # Not a real path (profiles RLS only grants anon no access at all), but
    # confirms the guard is an equality check against 'authenticated'
    # specifically, not "anything that isn't service_role".
    assert _trigger_would_allow(auth_role="anon", old_user_type="enrolled", new_user_type="learner")


@pytest.mark.parametrize("new_value", [None, ""])
def test_clearing_an_already_set_user_type_is_blocked(new_value):
    # A client sending an explicit null/empty value is still a CHANGE away
    # from an already-set value -- must not be a loophole for clearing the
    # column to re-run onboarding from a clean slate.
    assert not _trigger_would_allow(auth_role="authenticated", old_user_type="enrolled", new_user_type=new_value)


# ── Structural checks on the actual migration SQL ───────────────────────────

def test_migration_file_exists_and_is_idempotent():
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "create or replace function public.profiles_lock_user_type" in sql
    assert "drop trigger if exists profiles_lock_user_type_trg" in sql
    assert "before update on public.profiles" in sql
    assert "for each row" in sql


def test_migration_escapes_non_authenticated_roles_first():
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "auth.role() is distinct from 'authenticated'" in sql
    assert "return new" in sql


def test_migration_guards_on_both_old_value_present_and_value_change():
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "coalesce(old.user_type, '') <> ''" in sql
    assert "new.user_type is distinct from old.user_type" in sql
    assert "raise exception" in sql


def test_migration_is_explicitly_marked_not_yet_applied():
    # The remediation review requires separate, explicit approval before
    # this goes anywhere near production -- the migration file itself must
    # keep saying so until that approval is given, so a future reader (or
    # an automated deploy step scanning migration headers) can't mistake
    # this for an already-sanctioned change.
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "NOT applied yet" in sql or "not applied" in sql.lower()

"""Regression coverage for supabase/migrations/20261014_000002_security_definer_hardening.sql.

Same constraint as test_profiles_lock_user_type_migration.py: no Docker,
psql, or Supabase CLI is available in this sandboxed environment, so the
fixes could not be executed against a real Postgres instance. Two things
stand in for that here too:

1. `_rpc_would_allow` mirrors the exact guard line every one of the six
   patched functions now shares (`auth.role() <> 'service_role' and
   auth.uid() is distinct from p_user_id`) -- already proven correct in this
   project by bind_scoped_job_to_tutor_turn / create_ai_tutor_turn, which use
   the identical line in production today (confirmed by reading their live
   pg_get_functiondef output).
2. Structural assertions on the migration file's actual SQL text, so a
   hand-edit that drops a guard or the view fix is caught even though nothing
   here executes it.

Before this migration is ever applied to production: run it against a real
isolated Postgres instance and re-verify these scenarios live, and confirm
`ALTER VIEW ... SET (security_invoker = true)` actually restores per-user
scoping end to end (SELECT as two different authenticated test users against
daily_study_plans, confirm each sees only their own rows). That could not be
done here and is a genuine, separate gate, not a formality.
"""
from __future__ import annotations

from pathlib import Path

_MIGRATION_PATH = (
    Path(__file__).parents[3] / "supabase" / "migrations" / "20261014_000002_security_definer_hardening.sql"
)

_PATCHED_FUNCTIONS = [
    "activate_document_index_revision",
    "rollback_document_index_revision",
    "claim_ai_tutor_generation",
    "save_ai_tutor_state",
    "claim_pdf_region_ocr",
    "match_course_visuals",
]


def _rpc_would_allow(*, auth_role: str, auth_uid: str | None, p_user_id: str) -> bool:
    """Mirrors the shared guard line exactly:

        if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
          raise exception 'not_authorized';
        end if;

    Returns True if the call is ALLOWED (no exception raised).
    """
    if auth_role == "service_role":
        return True
    return auth_uid == p_user_id


# ── Behavioral mirror of the shared guard ───────────────────────────────────

def test_owner_calling_for_themselves_is_allowed():
    assert _rpc_would_allow(auth_role="authenticated", auth_uid="user-a", p_user_id="user-a")


def test_calling_with_someone_elses_user_id_is_blocked():
    # This is the exact confirmed gap: before the fix, none of the six
    # functions checked this at all.
    assert not _rpc_would_allow(auth_role="authenticated", auth_uid="user-a", p_user_id="user-b")


def test_anonymous_caller_with_no_session_is_blocked():
    assert not _rpc_would_allow(auth_role="anon", auth_uid=None, p_user_id="user-b")


def test_service_role_backend_path_is_never_blocked():
    # backend/python-ai always connects with the service role key -- must
    # stay unaffected so legitimate backend writes keep working.
    assert _rpc_would_allow(auth_role="service_role", auth_uid=None, p_user_id="user-a")
    assert _rpc_would_allow(auth_role="service_role", auth_uid="someone-else", p_user_id="user-a")


# ── Structural checks on the actual migration SQL ───────────────────────────

def test_migration_file_exists_and_patches_every_confirmed_function():
    sql = _MIGRATION_PATH.read_text("utf-8")
    for name in _PATCHED_FUNCTIONS:
        assert f"create or replace function public.{name}" in sql, f"{name} guard missing from migration"
    # The shared guard line itself, present once per patched function.
    assert sql.count("auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id") == len(
        _PATCHED_FUNCTIONS
    )


def test_migration_fixes_the_security_definer_view_leak():
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "alter view public.daily_study_plans set (security_invoker = true)" in sql


def test_migration_revokes_worker_only_rpc_from_client_roles():
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "revoke execute on function public.claim_next_scoped_job" in sql
    assert "from anon, authenticated" in sql


def test_migration_is_explicitly_marked_not_yet_applied():
    sql = _MIGRATION_PATH.read_text("utf-8")
    assert "not applied yet" in sql.lower()

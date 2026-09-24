-- Shared German Exam Engine — canonical exam-profile id on profiles.
--
-- Backward-compatible: german_test / german_level (read by the existing
-- frontend as window._germanTest / window._germanLevel) are kept untouched.
-- This column is resolved lazily on first use (app/services/
-- german_exam_profiles.py::resolve_profile_id) from (german_test,
-- german_level), not backfilled in bulk here — Phase 1's registry has
-- exactly one profile (telc_c1_hochschule), so most existing users will
-- simply resolve to NULL and keep using the static-content fallback.

alter table public.profiles
  add column if not exists german_exam_profile_id text;

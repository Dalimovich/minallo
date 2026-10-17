-- Lock profiles.user_type against change once set, at the database layer.
--
-- This column previously had no protection beyond the standard "owner can
-- update their own row" RLS policy (profiles_owner_update, USING/WITH CHECK:
-- id = auth.uid(), no column restriction) and a blanket authenticated/anon
-- UPDATE grant covering every column, user_type included -- confirmed live
-- via pg_policies and information_schema.column_privileges (2026-10-14
-- release-readiness audit; no trigger existed at all). Any signed-in user
-- could PATCH their own profiles.user_type directly through PostgREST,
-- bypassing onboarding entirely and self-granting German-learner-specific AI
-- prompt behavior (app/services/german_learner_profile.py's is_learner/
-- has_target gate purely on this column) with no onboarding ever having run.
--
-- This is also the database-level enforcement of the G13 product decision:
-- there is no supported student<->learner mode switch, in-app or otherwise
-- -- frontend/views/profile/profile.js never writes user_type at all, only
-- onboarding does.
--
-- Deliberately narrower than locking every learner-identity column: german_test
-- / german_level / german_exam_profile_id are legitimately re-saved by an
-- EXISTING learner from the Profile page (profile.js) to update their target
-- exam/level, and is_learner/has_target gate only on user_type -- those three
-- fields have no effect unless user_type is already 'learner', so leaving
-- them freely editable does not reopen this gap.
--
-- The trigger only blocks a CHANGE to an already-set (non-empty) value -- the
-- one-time onboarding write (empty -> a value) still works unchanged, and
-- re-saving the same value is a no-op, not an error. Enforcement is scoped to
-- auth.role() = 'authenticated' (ordinary signed-in PostgREST requests) so
-- the trusted backend's service-role connection is unaffected and
-- support/admin corrections remain possible outside PostgREST.
--
-- NOT applied yet -- proposed fix pending owner approval (see release-
-- readiness audit 2026-10-14, "user_type authorization" finding).

create or replace function public.profiles_lock_user_type()
returns trigger
language plpgsql
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;
  if coalesce(old.user_type, '') <> '' and new.user_type is distinct from old.user_type then
    raise exception 'user_type cannot be changed after it is set';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_lock_user_type_trg on public.profiles;
create trigger profiles_lock_user_type_trg
  before update on public.profiles
  for each row
  execute function public.profiles_lock_user_type();

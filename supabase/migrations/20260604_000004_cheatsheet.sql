-- Learning Agent (Phase 4): Cheatsheet.
--
-- A cheatsheet is a dense, exam-ready condensation of a course: the highest-
-- value formulas, definitions and rules, ranked by the course Topic Map's
-- importance and grounded in the user's own chunks. It is stored as markdown,
-- reusing the existing `notes` / `note_sources` tables (same RLS, same CRUD
-- edge function, same notes list UI) rather than a parallel table — a
-- cheatsheet is just another generated document, tagged with type 'cheatsheet'.
--
-- This migration only widens the `notes.type` check constraint to admit the
-- new value. No new tables.

do $$
declare
  v_conname text;  -- not "conname": that collides with pg_constraint.conname
begin
  -- The original constraint is an unnamed/auto-named CHECK on notes.type.
  -- Find and drop whichever check constraint governs `type`, then re-add one
  -- that includes 'cheatsheet'. Idempotent.
  select c.conname into v_conname
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'notes'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%type%'
    and pg_get_constraintdef(c.oid) ilike '%notes%';

  if v_conname is not null then
    execute format('alter table public.notes drop constraint %I', v_conname);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'notes_type_chk'
  ) then
    alter table public.notes
      add constraint notes_type_chk
      check (type in ('notes', 'summary', 'formula_sheet', 'cheatsheet'));
  end if;
end $$;

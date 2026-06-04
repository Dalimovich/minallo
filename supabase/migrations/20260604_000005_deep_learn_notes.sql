-- Learning Agent (Phase 5): persist Deep Learn lessons.
--
-- Deep Learn was read-only/ephemeral. To let students revisit past lessons we
-- store each generated lesson the same way cheatsheets are stored: as a row in
-- the existing `notes` table (markdown in content_markdown, citations in
-- note_sources), tagged with type 'deep_learn'. Same RLS, same /api/notes CRUD,
-- so the Deep Learn tab can list / open / delete saved lessons with no new
-- table or endpoint.
--
-- This migration only widens the `notes.type` check constraint to admit the
-- new value. No new tables.

do $$
declare
  v_conname text;  -- not "conname": that collides with pg_constraint.conname
begin
  -- Find and drop whichever CHECK constraint governs notes.type (named
  -- notes_type_chk after 20260604_000004, or auto-named before it), then re-add
  -- one that also allows 'deep_learn'. Idempotent.
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

  alter table public.notes
    add constraint notes_type_chk
    check (type in ('notes', 'summary', 'formula_sheet', 'cheatsheet', 'deep_learn'));
end $$;

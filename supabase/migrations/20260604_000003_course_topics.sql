-- Learning Agent Core (Phase 1): per-course aggregated Topic Map.
--
-- Topics already exist per-chunk (document_chunks.primary_topic, added in
-- 20260519_000006). This table rolls those up into one ranked, per-course map
-- — the foundation ExamForge, cheatsheets, the study planner and weak-topic
-- features all read from. It is DERIVED data: regenerated from document_chunks
-- by learning_agent.build_course_topic_map, so it is safe to delete/rebuild.
--
-- Writes go through the service-role backend (like user_topic_mastery and the
-- exam_* tables); the frontend only reads under RLS.

create table if not exists public.course_topics (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  course_id             text not null,
  name                  text not null,
  normalized_name       text not null,
  summary               text,
  importance            text not null default 'medium',  -- high | medium | low
  difficulty            text not null default 'medium',   -- high | medium | low
  chunk_count           integer not null default 0,
  source_pages          jsonb not null default '[]'::jsonb,
  source_chunk_ids      jsonb not null default '[]'::jsonb,
  source_document_ids   jsonb not null default '[]'::jsonb,
  related_exercise_ids  jsonb not null default '[]'::jsonb,
  related_formula_ids   jsonb not null default '[]'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, course_id, normalized_name)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'course_topics_importance_chk') then
    alter table public.course_topics
      add constraint course_topics_importance_chk check (importance in ('high','medium','low'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'course_topics_difficulty_chk') then
    alter table public.course_topics
      add constraint course_topics_difficulty_chk check (difficulty in ('high','medium','low'));
  end if;
end $$;

create index if not exists course_topics_user_course_idx
  on public.course_topics (user_id, course_id, importance);

alter table public.course_topics enable row level security;

drop policy if exists "course_topics_owner_select" on public.course_topics;
create policy "course_topics_owner_select" on public.course_topics
  for select using (auth.uid() = user_id);
-- No insert/update/delete policy: writes happen via the service-role backend
-- (learning_agent), which derives rows from the user's own document_chunks.

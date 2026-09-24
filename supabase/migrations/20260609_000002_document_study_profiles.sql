-- AI-Powered Weekly Mission Planner — Phase 1
--
-- document_study_profiles caches the AI's per-file "study understanding" so the
-- weekly planner can reason over compact profiles instead of re-reading every
-- document on every plan generation (slow + expensive). One row per document.
--
-- Staleness key: `source_signature` mirrors the document's content identity
-- (documents.document_hash, or indexed_at when no hash exists). The planner
-- rebuilds a profile only when the signature changes — i.e. the file was
-- re-indexed — so day-to-day plan loads pay zero LLM cost.

create table if not exists public.document_study_profiles (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  course_id         text        not null,
  document_id       uuid        not null references public.documents(id) on delete cascade,
  -- Content-identity signature the profile was built from. When this no longer
  -- matches the document's current hash/indexed_at, the profile is stale.
  source_signature  text,
  -- The AI study profile (documentRole, topicsCovered[], prerequisites[],
  -- estimatedStudyMinutes, recommendedUse, summary). Shape is owned by the
  -- Python study_planner service; stored opaquely here.
  profile           jsonb       not null default '{}',
  model             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (document_id)
);

create index if not exists idx_document_study_profiles_user_course
  on public.document_study_profiles (user_id, course_id);

drop trigger if exists set_document_study_profiles_updated_at on public.document_study_profiles;
create trigger set_document_study_profiles_updated_at
  before update on public.document_study_profiles
  for each row execute function public.update_updated_at_column();

alter table public.document_study_profiles enable row level security;

drop policy if exists "document_study_profiles_owner" on public.document_study_profiles;
create policy "document_study_profiles_owner" on public.document_study_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

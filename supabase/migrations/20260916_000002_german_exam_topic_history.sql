-- Shared German Exam Engine — topic anti-repetition history.
--
-- Kept as its own table rather than derived from german_exam_attempts:
-- topic selection happens at GENERATION time, before any attempt exists, so
-- it cannot be sourced from an attempts join. Folding it into attempts would
-- also duplicate topic_id across every question row of a generated part.

create table if not exists public.german_exam_topic_history (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  profile_id  text        not null,
  module      text        not null check (module in
                 ('listening', 'reading', 'writing', 'speaking', 'language_elements')),
  part_id     text        not null,
  topic_id    text        not null,
  used_at     timestamptz not null default now()
);

create index if not exists idx_german_exam_topic_history_lookup
  on public.german_exam_topic_history (user_id, profile_id, module, part_id, used_at desc);

alter table public.german_exam_topic_history enable row level security;

drop policy if exists "german_exam_topic_history_owner" on public.german_exam_topic_history;
create policy "german_exam_topic_history_owner" on public.german_exam_topic_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

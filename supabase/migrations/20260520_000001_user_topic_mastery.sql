-- Phase 2 of the tutor-mode plan: per-(user, course, topic) mastery skeleton.
--
-- Each row represents how a student is doing on one topic in one course. The
-- mastery_score column is the Laplace-smoothed correct ratio so a single
-- correct answer doesn't pin a topic at 100%. Writes go through the
-- /api/ai/quiz-attempt endpoint with the service-role key; reads happen via
-- /api/ai/mastery and the dashboard widget (PostgREST under RLS).

create table if not exists public.user_topic_mastery (
  user_id            uuid        not null references auth.users(id) on delete cascade,
  course_id          text        not null,
  topic              text        not null,
  attempts           int         not null default 0,
  correct            int         not null default 0,
  mastery_score      real        not null default 0,
  last_practiced_at  timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (user_id, course_id, topic)
);

alter table public.user_topic_mastery enable row level security;

drop policy if exists "own rows read" on public.user_topic_mastery;
create policy "own rows read"
  on public.user_topic_mastery
  for select
  using (user_id = auth.uid());

-- No insert/update/delete policy — writes go through the service-role
-- backend (ai-quiz-attempt) which validates topic strings against the
-- course's known primary_topic values.

create index if not exists user_topic_mastery_user_course_idx
  on public.user_topic_mastery (user_id, course_id, mastery_score);
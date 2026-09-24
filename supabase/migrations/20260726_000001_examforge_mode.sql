alter table public.exam_sessions
  add column if not exists mode text not null default 'exam'
  check (mode in ('exam', 'practice'));

alter table public.subscriptions
  add column if not exists pause_started_at timestamptz,
  add column if not exists pause_resumes_at timestamptz,
  add column if not exists pause_reason text;


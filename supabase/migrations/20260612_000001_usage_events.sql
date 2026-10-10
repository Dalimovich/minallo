-- Migration: OpenAI usage metering.
--
-- One row per OpenAI call (completions, embeddings, vision OCR), written
-- fire-and-forget by backend/python-ai/app/services/usage_meter.py with the
-- service role. Answers "what does one user / one feature cost per month":
--
--   select feature, model,
--          sum(prompt_tokens) as in_tok, sum(cached_tokens) as cached,
--          sum(completion_tokens) as out_tok
--   from usage_events
--   where created_at > now() - interval '30 days'
--   group by 1, 2 order by 3 desc;
--
-- Costs are derived at query time from token counts so a pricing change
-- never requires a backfill. user_id is nullable: service-level calls with
-- no request context (indexing, embeddings) land unattributed but still
-- count toward feature totals.

create table if not exists usage_events (
  id                bigint generated always as identity primary key,
  user_id           uuid,
  feature           text not null,
  model             text not null,
  prompt_tokens     int  not null default 0,
  completion_tokens int  not null default 0,
  cached_tokens     int  not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists usage_events_user_time_idx
  on usage_events (user_id, created_at desc);
create index if not exists usage_events_feature_time_idx
  on usage_events (feature, created_at desc);
create index if not exists usage_events_time_idx
  on usage_events (created_at desc);

-- Service-role writes only. RLS enabled with no policies = anon/authed
-- clients can neither read nor write; the meter uses the service key.
alter table usage_events enable row level security;

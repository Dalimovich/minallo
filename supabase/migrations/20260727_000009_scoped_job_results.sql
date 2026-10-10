-- Persist the renderable exhaustive result so an offline browser can restore it.
alter table public.complete_document_jobs
  add column if not exists final_text text,
  add column if not exists result_payload jsonb not null default '{}'::jsonb;

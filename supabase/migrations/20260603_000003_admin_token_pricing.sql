-- Token-metered AI pricing for the admin Financial Overview.
--
-- Adds per-token prices so the dashboard can compute REAL AI spend for
-- interactive (ask/stream) calls from the prompt/completion token counts
-- already recorded in retrieval_debug_log, instead of a flat per-call
-- estimate. Generation calls (quiz/flashcards/notes) keep the per-call
-- estimate until their token usage is persisted too.
--
-- Prices are stored as cents per 1,000,000 tokens. Defaults track Claude
-- Sonnet list pricing: ~$3 / 1M input, ~$15 / 1M output.

alter table public.admin_financial_config
  add column if not exists ai_input_cost_cents_per_m  numeric not null default 300,
  add column if not exists ai_output_cost_cents_per_m numeric not null default 1500;

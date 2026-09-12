-- Editable cost inputs for the admin Financial Overview.
--
-- The dashboard computes revenue and AI cost from real data (active paid
-- subscriptions × price, and monthly AI request counts from security_events),
-- but the *fixed* costs (Supabase, hosting, payment-fee rates, per-call AI
-- cost estimates) can't be queried — so they live here as a single editable
-- row the admin sets in the UI. All money is stored in integer cents;
-- percentages as numeric.

create table if not exists public.admin_financial_config (
  id                      integer primary key default 1,
  monthly_price_cents     integer not null default 1199,   -- subscription price
  payment_fee_pct         numeric not null default 2.9,    -- % per transaction
  payment_fee_fixed_cents integer not null default 35,     -- fixed per transaction
  ai_interactive_cost_cents numeric not null default 0.10, -- est. cost per chat/RAG/ask call
  ai_generation_cost_cents  numeric not null default 0.50, -- est. cost per quiz/flashcard/notes gen
  supabase_cost_cents     integer not null default 2500,   -- monthly Supabase bill
  hosting_cost_cents      integer not null default 500,    -- monthly Cloudflare/hosting
  other_cost_cents        integer not null default 0,      -- email, misc
  updated_at              timestamptz not null default now(),
  -- Pin to a single row.
  constraint admin_financial_config_singleton check (id = 1)
);

-- Seed the singleton row so GET always returns config.
insert into public.admin_financial_config (id) values (1)
on conflict (id) do nothing;

-- Lock down: only the service role (used by the admin function) may read/write.
-- RLS enabled with no policies denies anon/authenticated; service role bypasses.
alter table public.admin_financial_config enable row level security;

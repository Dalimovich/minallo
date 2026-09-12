-- Stage 3: Flashcard spaced repetition (SM-2) review state.
--
-- DESIGN: a DEDICATED table keyed by (user_id, deck_id, card_index) — NOT an
-- extension of study_item_progress and NOT a change to flashcard_decks.cards.
--
-- Why dedicated:
--   • The frontend (frontend/views/flashcards/flashcards.js) loads/studies decks
--     straight from flashcard_decks, whose `cards` is a JSONB ARRAY. Cards have
--     NO stable per-row id — only their array position. study_item_progress keys
--     on study_items.id, a SEPARATE storage path the deck UI never touches, so
--     reusing it would not line up with how cards are actually addressed.
--   • Keeping review state in its own table means we never rewrite the cards blob
--     (so generation/edit paths are untouched) and an upsert is a single tiny row.
--
-- A card is addressed by (deck_id, card_index). If a deck's cards array is later
-- reordered or trimmed, stale rows for removed indexes simply go unused — they do
-- no harm (the study session only reads state for indexes that still exist).
--
-- BACK-COMPAT: there is intentionally NO backfill here. Every existing card has NO
-- row, and "no row" is interpreted by the app as "new, due now" WITHOUT stamping a
-- shared due_at across the whole deck. New cards therefore keep their natural deck
-- order instead of all becoming simultaneously-overdue and mis-ordered. Only cards
-- the learner actually rates get a row + a real due_at.

create table if not exists public.flashcard_review_state (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  deck_id          uuid        not null references public.flashcard_decks(id) on delete cascade,
  card_index       int         not null,            -- position within flashcard_decks.cards

  -- SM-2 scheduling state
  due_at           timestamptz not null default now(),
  interval_days    numeric     not null default 0,  -- current interval; 0 until first non-lapse review
  ease_factor      numeric     not null default 2.5,-- SM-2 EF, floored at 1.3
  review_count     int         not null default 0,  -- successful (>= Good) reviews in a row contributing to growth
  lapse_count      int         not null default 0,  -- times rated Again
  rating           text        check (rating in ('again','hard','good','easy')),  -- last rating
  last_reviewed_at timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (user_id, deck_id, card_index),
  check (card_index >= 0)
);

-- Study-session ordering reads due reviewed cards for one (user, deck) by due_at.
create index if not exists idx_flashcard_review_state_user_deck_due
  on public.flashcard_review_state (user_id, deck_id, due_at);

-- Keep updated_at fresh via the shared trigger function.
drop trigger if exists set_flashcard_review_state_updated_at on public.flashcard_review_state;
create trigger set_flashcard_review_state_updated_at
  before update on public.flashcard_review_state
  for each row execute function public.update_updated_at_column();

alter table public.flashcard_review_state enable row level security;

-- Owner-scoped RLS: a user can only see/write their own review state.
drop policy if exists "flashcard_review_state_owner" on public.flashcard_review_state;
create policy "flashcard_review_state_owner" on public.flashcard_review_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Chatbot "Save to notes" replies — durable server copy.
--
-- Saved replies previously lived ONLY in localStorage (ss_ncb_chats_v1:<uid>),
-- so clearing browser data or switching devices lost them. This table is the
-- durable copy; localStorage stays as the instant read/write cache and the two
-- are merged whenever the Notes tab opens.
--
-- DESIGN: ids are CLIENT-generated ('rep_…'), because a reply must be saved
-- and rendered instantly offline-first, then pushed in the background. The id
-- is therefore only unique per user → primary key (user_id, id). chat_id is
-- the client-generated chat id ('ncb_…') — chats themselves are a localStorage
-- concept with no server table, so there is nothing to reference.

create table if not exists public.chat_saved_replies (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,  -- client-generated 'rep_…' id
  chat_id    text        not null,  -- client-generated 'ncb_…' chat id
  reply_text text        not null,
  created_at timestamptz not null default now(),

  primary key (user_id, id),
  check (char_length(id) <= 64),
  check (char_length(chat_id) <= 64),
  check (char_length(reply_text) <= 80000)  -- matches NCB_MAX_STORED_MESSAGE_CHARS
);

-- The Notes tab lists one (user, chat) newest-first.
create index if not exists idx_chat_saved_replies_user_chat
  on public.chat_saved_replies (user_id, chat_id, created_at desc);

alter table public.chat_saved_replies enable row level security;

-- Owner-scoped RLS: a user can only see/write their own saved replies.
-- (The API goes through the service role, but keep direct access safe too.)
drop policy if exists "chat_saved_replies_owner" on public.chat_saved_replies;
create policy "chat_saved_replies_owner" on public.chat_saved_replies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

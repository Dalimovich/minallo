-- ============================================================================
-- RLS cleanup — Stage 2 (DO NOT APPLY blindly — TEST DMs FIRST)
-- ============================================================================
-- This migration closes the HIGH-severity holes where any authenticated user
-- could read all messages, all room memberships, all reactions, etc. The
-- naïve fix (just drop the loose policies) would break direct messages,
-- because DM rooms use a synthetic id `dm_<uidA>_<uidB>` and have no row in
-- room_members.
--
-- Strategy:
--   1. Create a SECURITY DEFINER helper `user_can_access_room(text)` that
--      returns true when the caller is allowed to see messages/state for the
--      given room_id. It handles:
--        - the public 'general' app room
--        - DM rooms — caller's uid must be one of the two embedded in the id
--        - custom rooms — caller must be a row in room_members
--   2. Add new strict policies that use this helper.
--   3. Drop the over-broad legacy policies.
--
-- Before applying:
--   ✅ Restore a recent prod backup to a staging Supabase project, OR
--   ✅ Apply on a non-production environment first
--   ✅ Smoke-test:
--      • open a DM with another user → messages load, can send + receive
--      • read pinned messages, reactions, typing indicators in a DM
--      • open a custom room you're a member of → same checks
--      • open a custom room you're NOT a member of → cannot read messages
--
-- Rollback:
--   To restore the previous (insecure) behavior, recreate the dropped
--   policies. The originals are listed in the comments below.

begin;

-- ── 1. Helper function ──────────────────────────────────────────────────────
-- SECURITY DEFINER so the function bypasses RLS on room_members when checking
-- membership — otherwise it would recurse with row_members's own RLS policy.
-- STABLE because we call it inside RLS qual expressions, where Postgres
-- benefits from caching across rows in the same statement.
create or replace function public.user_can_access_room(p_room_id text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return false;
  end if;

  -- Public app room (legacy fixed id used in the chat UI)
  if p_room_id = 'general' then
    return true;
  end if;

  -- Direct message convention: 'dm_<uuidA>_<uuidB>'
  -- The caller must be one of the two UUIDs embedded in the id.
  if p_room_id like 'dm\_%' then
    return position(v_uid::text in p_room_id) > 0;
  end if;

  -- Custom rooms (including the legacy 'custom_<uuid>' shape some clients send)
  declare
    v_normalized text := case
      when p_room_id like 'custom\_%' then substring(p_room_id from 8)
      else p_room_id
    end;
  begin
    return exists (
      select 1
      from public.room_members rm
      where rm.room_id::text = v_normalized
        and rm.user_id = v_uid
    );
  end;
end;
$$;

revoke all on function public.user_can_access_room(text) from public;
grant execute on function public.user_can_access_room(text) to authenticated;

-- ── 2. New strict SELECT policies ───────────────────────────────────────────

-- public.messages — replaces "anyone logged in can read"
drop policy if exists messages_select_v2 on public.messages;
create policy messages_select_v2
  on public.messages
  for select
  to authenticated
  using (public.user_can_access_room(room_id));

-- public.chat_messages — DM messages do NOT live here per current code, but
-- we keep the same gate for defense in depth (chat_messages.room_id is text).
drop policy if exists chat_messages_select_v2 on public.chat_messages;
create policy chat_messages_select_v2
  on public.chat_messages
  for select
  to authenticated
  using (public.user_can_access_room(room_id));

-- public.pinned_messages — strict prior policy only worked for room_members
drop policy if exists pinned_messages_select_v2 on public.pinned_messages;
create policy pinned_messages_select_v2
  on public.pinned_messages
  for select
  to authenticated
  using (public.user_can_access_room(room_id));

-- public.typing_indicators
drop policy if exists typing_indicators_select_v2 on public.typing_indicators;
create policy typing_indicators_select_v2
  on public.typing_indicators
  for select
  to authenticated
  using (public.user_can_access_room(room_id));

-- public.room_nicknames
drop policy if exists room_nicknames_select_v2 on public.room_nicknames;
create policy room_nicknames_select_v2
  on public.room_nicknames
  for select
  to authenticated
  using (public.user_can_access_room(room_id));

-- public.message_reactions — must join to the parent message to find room_id
drop policy if exists message_reactions_select_v2 on public.message_reactions;
create policy message_reactions_select_v2
  on public.message_reactions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages m
      where m.id = message_reactions.message_id
        and public.user_can_access_room(m.room_id)
    )
  );

-- public.room_members — let users see the membership of rooms they're in.
-- "I'm in this room" OR "the row is my own membership".
drop policy if exists room_members_select_v2 on public.room_members;
create policy room_members_select_v2
  on public.room_members
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.room_members rm2
      where rm2.room_id = room_members.room_id
        and rm2.user_id = auth.uid()
    )
  );

-- ── 3. Drop the over-broad legacy policies ──────────────────────────────────
-- These are the OR-semantic escape hatches that defeat every strict policy
-- above. The new *_v2 policies cover the legitimate access patterns.

-- HIGH severity drops
drop policy if exists "anyone logged in can read"               on public.messages;
drop policy if exists "Anyone logged in can read messages"      on public.chat_messages;
drop policy if exists "Members can read"                        on public.room_members;

-- MEDIUM severity drops (privacy leaks)
drop policy if exists "Anyone can read pins"                    on public.pinned_messages;
drop policy if exists "Anyone can read reactions"               on public.message_reactions;
drop policy if exists "Anyone can read nicknames"               on public.room_nicknames;
drop policy if exists "Anyone can read typing"                  on public.typing_indicators;

-- Also drop redundant strict SELECT policies that are now superseded by *_v2.
-- These don't open new holes (their checks are subsets of *_v2), but cleaning
-- them up keeps the policy list readable.
drop policy if exists "Room members can read messages"          on public.messages;
drop policy if exists "Room members can read chat messages"     on public.chat_messages;
drop policy if exists "Room members can read pinned messages"   on public.pinned_messages;
drop policy if exists "Room members can read typing indicators" on public.typing_indicators;
drop policy if exists "Room members can read nicknames in their rooms" on public.room_nicknames;
drop policy if exists "Room members can read message reactions" on public.message_reactions;
drop policy if exists "Users can read their own room memberships" on public.room_members;

commit;

-- ── 4. Post-apply verification ──────────────────────────────────────────────
-- Run this and confirm the only SELECT policies on these tables are *_v2:
--
-- select tablename, policyname, cmd
-- from pg_policies
-- where schemaname='public'
--   and tablename in ('messages','chat_messages','pinned_messages',
--                     'typing_indicators','room_nicknames','message_reactions',
--                     'room_members')
--   and cmd='SELECT'
-- order by tablename, policyname;
--
-- Smoke tests in the app:
--   ☐ DM with another user — send + receive works
--   ☐ Reactions on DM messages render
--   ☐ Typing indicator in DM
--   ☐ Public room (visibility='public') readable by non-members
--   ☐ Private room readable by members, NOT by non-members
--   ☐ /chat-friends still loads

-- ============================================================================
-- RLS cleanup — Stage 3 (write-side)  — APPLY AFTER STAGE 2 + DM SMOKE TEST
-- ============================================================================
-- Stage 2 closed read holes. Stage 3 closes the symmetric "write anywhere"
-- holes: today, several tables accept INSERTs into any room_id as long as
-- the inserter sets their own user_id. That allows:
--   - Message spam into DMs/rooms the user can't read
--   - Self-joining ANY private room (room_members) without an invite code,
--     bypassing the join-room-by-code Pages Function
--   - Pinning / reacting / typing into arbitrary rooms
--
-- Fix: gate INSERTs through user_can_access_room() (defined in stage 2) for
-- chat surfaces, and use a narrower policy for room_members itself.
--
-- Prerequisite:
--   • Stage 2 migration applied (provides public.user_can_access_room)
--
-- Smoke tests after applying:
--   ☐ Send a DM message  → works (user_can_access_room returns true for the DM)
--   ☐ Send a custom-room message as member  → works
--   ☐ Send a message into a room you're NOT in  → 401/403 from PostgREST
--   ☐ Create a custom room  → creator auto-join still works
--   ☐ Join a public room from search  → works
--   ☐ Attempt to self-insert into a private room you weren't invited to → fails
--   ☐ Join via invite code (join-room-by-code function) → still works
--     (uses service_role, bypasses RLS)
--   ☐ Pin a message in a DM/room you access → works
--   ☐ React to a message in a DM/room you access → works
--   ☐ Typing indicator in a DM → works

begin;

-- ── messages ────────────────────────────────────────────────────────────────
drop policy if exists messages_insert_v2 on public.messages;
create policy messages_insert_v2
  on public.messages
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  );

drop policy if exists "users insert own messages"   on public.messages;
drop policy if exists "Room members can send messages" on public.messages;

-- ── chat_messages (legacy table) ────────────────────────────────────────────
drop policy if exists chat_messages_insert_v2 on public.chat_messages;
create policy chat_messages_insert_v2
  on public.chat_messages
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  );

drop policy if exists "Room members can send chat messages" on public.chat_messages;

-- ── pinned_messages ─────────────────────────────────────────────────────────
drop policy if exists pinned_messages_insert_v2 on public.pinned_messages;
create policy pinned_messages_insert_v2
  on public.pinned_messages
  for insert
  to authenticated
  with check (
    pinned_by = auth.uid()
    and public.user_can_access_room(room_id)
    and exists (
      select 1 from public.messages m
      where m.id = pinned_messages.message_id
        and m.room_id = pinned_messages.room_id
    )
  );

drop policy if exists "Users can pin"                on public.pinned_messages;
drop policy if exists "Room members can pin messages" on public.pinned_messages;

-- ── message_reactions ───────────────────────────────────────────────────────
drop policy if exists message_reactions_insert_v2 on public.message_reactions;
create policy message_reactions_insert_v2
  on public.message_reactions
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.messages m
      where m.id = message_reactions.message_id
        and public.user_can_access_room(m.room_id)
    )
  );

drop policy if exists "Users can add reactions"           on public.message_reactions;
drop policy if exists "Users can create their own reactions" on public.message_reactions;

-- ── typing_indicators ───────────────────────────────────────────────────────
drop policy if exists typing_indicators_insert_v2 on public.typing_indicators;
create policy typing_indicators_insert_v2
  on public.typing_indicators
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  );

drop policy if exists typing_indicators_update_v2 on public.typing_indicators;
create policy typing_indicators_update_v2
  on public.typing_indicators
  for update
  to authenticated
  using (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  )
  with check (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  );

drop policy if exists "Users can upsert typing"                  on public.typing_indicators;
drop policy if exists "Users can update typing"                  on public.typing_indicators;
drop policy if exists "Users can create their own typing indicator" on public.typing_indicators;
drop policy if exists "Users can update their own typing indicator" on public.typing_indicators;

-- ── room_nicknames ──────────────────────────────────────────────────────────
drop policy if exists room_nicknames_insert_v2 on public.room_nicknames;
create policy room_nicknames_insert_v2
  on public.room_nicknames
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  );

drop policy if exists room_nicknames_update_v2 on public.room_nicknames;
create policy room_nicknames_update_v2
  on public.room_nicknames
  for update
  to authenticated
  using (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  )
  with check (
    user_id = auth.uid()
    and public.user_can_access_room(room_id)
  );

drop policy if exists "Users set own nickname"              on public.room_nicknames;
drop policy if exists "Users update own nickname"           on public.room_nicknames;
drop policy if exists "Users can set their own nickname"    on public.room_nicknames;
drop policy if exists "Users can update their own nickname" on public.room_nicknames;

-- ── room_members ────────────────────────────────────────────────────────────
-- The legitimate self-insert paths in the frontend code:
--   (a) Creator joining the room they just created   (custom_rooms.created_by = me)
--   (b) Joining a public room from search             (custom_rooms.visibility='public')
-- All other joins MUST go through the join-room-by-code Pages Function, which
-- uses the service_role and bypasses RLS. Direct self-insert into a private
-- room without an invite code is now blocked.
drop policy if exists room_members_insert_v2 on public.room_members;
create policy room_members_insert_v2
  on public.room_members
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.custom_rooms cr
      where cr.id = room_members.room_id
        and (cr.created_by = auth.uid() or cr.visibility = 'public')
    )
  );

drop policy if exists "Users can join"                  on public.room_members;
drop policy if exists "Users can join rooms as themselves" on public.room_members;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
-- select tablename, policyname, cmd
-- from pg_policies
-- where schemaname='public'
--   and tablename in ('messages','chat_messages','pinned_messages',
--                     'message_reactions','typing_indicators','room_nicknames',
--                     'room_members')
--   and cmd in ('INSERT','UPDATE')
-- order by tablename, cmd, policyname;
--
-- Manual fuzz check (run as a regular logged-in user, NOT service_role):
--   -- should succeed: send into a DM with yourself + a friend
--   insert into messages (room_id, user_id, content)
--     values ('dm_' || least(auth.uid()::text, '<friend_uid>') || '_' ||
--                       greatest(auth.uid()::text, '<friend_uid>'),
--             auth.uid(), 'test');
--
--   -- should fail with 'new row violates row-level security policy':
--   insert into messages (room_id, user_id, content)
--     values ('dm_<stranger_a>_<stranger_b>', auth.uid(), 'spam');
--
--   insert into room_members (room_id, user_id)
--     values ('<some_private_room_uuid>', auth.uid());

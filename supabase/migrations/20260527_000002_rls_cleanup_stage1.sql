-- ============================================================================
-- RLS cleanup — Stage 1 (SAFE to apply to production immediately)
-- ============================================================================
-- This migration removes over-broad policies that have NO dependency on the
-- direct-message convention (room_id = 'dm_<uidA>_<uidB>'). The stricter
-- replacement policies for each table are already in place — these drops
-- simply remove redundant permissive rules whose OR-semantics were defeating
-- the strict ones.
--
-- Stage 2 (separate migration) handles policies whose naive removal would
-- break DM message reads — those need new DM-aware replacement policies first.
--
-- Pre-flight verification (run before applying):
--   select policyname from pg_policies
--   where schemaname='public' and tablename='pinned_messages'
--     and policyname='Users can unpin';
--   -- should return 1 row
--
-- Post-apply verification:
--   select policyname, cmd, qual from pg_policies
--   where schemaname='public'
--     and tablename in ('pinned_messages','custom_rooms')
--   order by tablename, policyname;

begin;

-- ── H1: pinned_messages — anyone could delete any pin ──────────────────────
-- Strict replacement already exists: "Users can unpin messages they pinned"
-- (DELETE, authenticated, pinned_by = auth.uid()). Works for custom rooms AND
-- DMs because it scopes by pin owner, not by room membership.
drop policy if exists "Users can unpin" on public.pinned_messages;

-- ── H5: custom_rooms — anyone could enumerate private rooms + invite codes ─
-- Strict replacement already exists: "Users can read visible rooms"
-- (SELECT, authenticated, created_by = me OR visibility = 'public' OR I'm a
-- member). DM rooms are NOT stored in custom_rooms, so no DM impact.
drop policy if exists "Anyone can read rooms" on public.custom_rooms;

-- Duplicate redundant INSERT policy on custom_rooms — strict equivalent
-- "Users can insert their own rooms" (authenticated) covers creation.
-- If with_check on this one is null it lets a user create rooms with any
-- created_by value; the strict authenticated policy is the one we want.
drop policy if exists "Authenticated users can create rooms" on public.custom_rooms;

-- ── Redundant SELECT duplicates on chat_messages where a strict version
-- already exists, AND on tables that have no DM concept. The strict
-- "Room members can read chat messages" remains. NOTE: if your app uses
-- chat_messages for DMs too, move this to Stage 2 — but the codebase
-- writes DMs to public.messages (not chat_messages), so this is safe.
drop policy if exists "Anyone logged in can read messages" on public.chat_messages;
-- Duplicate write policies — strict "Room members can send chat messages"
-- and "Users can delete their own chat messages" (both authenticated) remain.
drop policy if exists "Users can insert their own messages" on public.chat_messages;
drop policy if exists "users can delete own messages" on public.chat_messages;

-- ── Redundant DELETE policy duplicate on public.messages
-- "Users can delete their own messages" (authenticated) remains.
drop policy if exists "users can delete own messages" on public.messages;

-- ── Redundant duplicates on settings — both have the same auth.uid() = id
-- check, just keep the per-cmd authenticated set.
drop policy if exists "own" on public.settings;
drop policy if exists "Users can manage their own data" on public.settings;

-- ── Redundant duplicate on editor_docs — strict per-cmd authenticated
-- policies remain.
drop policy if exists "own docs" on public.editor_docs;

-- ── Redundant duplicate on lecture_notes
drop policy if exists "Users manage own notes" on public.lecture_notes;

-- ── Redundant duplicates on friendships (kept the authenticated set)
drop policy if exists "Users can insert friend requests" on public.friendships;
drop policy if exists "Users can accept friend requests" on public.friendships;
drop policy if exists "Users can read their own friendships" on public.friendships;

-- ── Redundant duplicate on blocked_users
drop policy if exists "Users manage own blocks" on public.blocked_users;

commit;

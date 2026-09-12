-- ============================================================================
-- HOTFIX — room_members_select_v2 was recursive, breaking storage validation
-- ============================================================================
-- The Stage 2 migration created this policy on public.room_members:
--
--   create policy room_members_select_v2
--     on public.room_members for select to authenticated
--     using (
--       user_id = auth.uid()
--       or exists (select 1 from public.room_members rm2 ...)   -- ← recursive
--     );
--
-- The inner `select 1 from public.room_members rm2` re-triggers RLS on
-- room_members, which re-evaluates the same policy → infinite policy
-- recursion. Postgres aborts the query, and because a storage policy on
-- storage.objects (`Room members can read chat attachments`) joins to
-- room_members, the whole storage schema fails validation. The user-visible
-- symptom is /storage/v1/object/list/<bucket> returning:
--   503 DatabaseInvalidObjectDefinition
--     "The database schema is invalid or incompatible."
-- — for every bucket, not just chat-attachments, because Supabase validates
-- the whole schema upfront.
--
-- Fix: route the "am I in this room" lookup through user_can_access_room(),
-- which is SECURITY DEFINER and therefore bypasses RLS for its internal
-- room_members query. No more recursion.

begin;

drop policy if exists room_members_select_v2 on public.room_members;

create policy room_members_select_v2
  on public.room_members
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.user_can_access_room(room_members.room_id::text)
  );

commit;

-- Verification:
--   • /storage/v1/object/list/course-uploads should return 200 with the
--     normal items array.
--   • The chat (custom rooms, DMs) should still work end-to-end —
--     user_can_access_room covers the same cases the recursive policy did.

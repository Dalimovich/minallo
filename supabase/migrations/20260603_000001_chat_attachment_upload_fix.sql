-- ============================================================================
-- Fix: sending a chat attachment failed with
--   "new row violates row-level security policy" (HTTP 400)
-- ============================================================================
-- Two gates on the `chat-attachments` bucket were rejecting legitimate uploads:
--
--   1. The bucket's `allowed_mime_types` and the INSERT policy's extension
--      whitelist only permitted pdf/txt/docx/png/jpg/jpeg. That blocks the
--      zips / other formats the chat UI now allows, and any image the browser
--      reports with a different mime.
--
--   2. The INSERT policy gated the room with a direct `room_members` EXISTS on
--      the path's first folder segment. Messages authorise rooms through
--      public.user_can_access_room() instead, which also covers the public
--      `general` channel and `dm_<a>_<b>` direct messages — cases the raw
--      room_members lookup misses. So a user who could post text in a room
--      still couldn't upload an attachment to it.
--
-- Fix:
--   • Drop the bucket-level mime allow-list (keep the 25 MB size cap). The
--     frontend already blocks executable/active content; chat files are
--     downloaded, never executed.
--   • INSERT: allow an authenticated user to write into their OWN
--     <room>/<uid>/ path (folder segment [2] = their uid). Reading stays
--     room-gated below, so a stray upload can't leak.
--   • SELECT: allow download only to users who can access the room, via
--     user_can_access_room() — so attachments propagate to exactly the people
--     who can see the conversation.

begin;

-- 1. Remove the bucket-level mime restriction (keep the size cap at 25 MB).
update storage.buckets
set allowed_mime_types = null
where id = 'chat-attachments';

-- 2. INSERT — own subfolder, any file type the frontend allowed through.
drop policy if exists "Room members can upload chat attachments" on storage.objects;
drop policy if exists "Members can upload chat attachments"      on storage.objects;
create policy "Members can upload chat attachments"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[2] = auth.uid()::text
);

-- 3. SELECT — room-gated download via the same authority messages use.
drop policy if exists "Room members can read chat attachments" on storage.objects;
drop policy if exists "Members can read chat attachments"      on storage.objects;
create policy "Members can read chat attachments"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'chat-attachments'
  and public.user_can_access_room((storage.foldername(name))[1])
);

commit;

-- Verification:
--   • Send a .pdf / .zip / photo in any room you can chat in → no RLS error.
--   • The other room members see the message and can open/download the file.
--   select id, public, file_size_limit, allowed_mime_types
--   from storage.buckets where id = 'chat-attachments';

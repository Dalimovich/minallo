-- The account-wide Saved AI responses listing (no chat_id filter) orders by
-- created_at desc with id desc as a tiebreaker so keyset/cursor pagination
-- past the old 200-row cap is stable (each page asks for rows strictly after
-- the previous page's last (created_at, id) tuple). Neither existing
-- composite index (user_id, chat_id, created_at desc) nor (user_id,
-- course_id, created_at desc) can satisfy that order when chat_id/course_id
-- aren't constrained.
create index if not exists idx_chat_saved_replies_user_created
  on public.chat_saved_replies (user_id, created_at desc, id desc);

alter table public.chat_saved_replies
  add column if not exists course_id text,
  add column if not exists source_message_id text,
  add column if not exists source_prompt text,
  add column if not exists content_fingerprint text;

alter table public.chat_saved_replies
  drop constraint if exists chat_saved_replies_source_prompt_length;
alter table public.chat_saved_replies
  add constraint chat_saved_replies_source_prompt_length
  check (source_prompt is null or char_length(source_prompt) <= 1000);

-- Backfill only chats having exactly one known non-null course for this owner.
with unambiguous as (
  select user_id, client_conversation_id, min(course_id) as course_id
  from public.ai_chat_conversations
  where course_id is not null
  group by user_id, client_conversation_id
  having count(distinct course_id) = 1
)
update public.chat_saved_replies saved
set course_id = source.course_id
from unambiguous source
where saved.course_id is null
  and saved.user_id = source.user_id
  and saved.chat_id = source.client_conversation_id;

-- Existing rows need fingerprints before the scoped uniqueness constraint.
update public.chat_saved_replies
set content_fingerprint = encode(
  extensions.digest(convert_to(trim(replace(reply_text, E'\r\n', E'\n')), 'UTF8'), 'sha256'),
  'hex'
)
where content_fingerprint is null;

-- Keep the oldest canonical row when legacy duplicates already exist.
delete from public.chat_saved_replies newer
using public.chat_saved_replies older
where newer.user_id = older.user_id
  and coalesce(newer.course_id, '') = coalesce(older.course_id, '')
  and newer.content_fingerprint = older.content_fingerprint
  and (newer.created_at, newer.id) > (older.created_at, older.id);

create unique index if not exists uq_chat_saved_replies_source_message
  on public.chat_saved_replies (user_id, source_message_id)
  where source_message_id is not null;

create unique index if not exists uq_chat_saved_replies_scoped_content
  on public.chat_saved_replies (user_id, coalesce(course_id, ''), content_fingerprint)
  where content_fingerprint is not null;

create index if not exists idx_chat_saved_replies_user_course
  on public.chat_saved_replies (user_id, course_id, created_at desc);

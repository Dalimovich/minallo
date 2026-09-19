create table if not exists public.ai_chat_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  course_id text,
  document_id uuid references public.documents(id) on delete set null,
  original_filename text not null,
  storage_bucket text not null default 'chat-attachments',
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint,
  upload_status text not null default 'ready' check (upload_status in ('uploading','ready','failed')),
  indexing_status text check (indexing_status is null or indexing_status in ('pending','processing','ready','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, storage_bucket, storage_path)
);

create table if not exists public.ai_chat_message_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  client_message_id text not null,
  file_id uuid not null references public.ai_chat_files(id) on delete restrict,
  attachment_order integer not null default 0,
  page_number integer,
  region_id text,
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id, file_id, attachment_order),
  foreign key (conversation_id, client_message_id)
    references public.ai_chat_messages(conversation_id, client_message_id) on delete cascade
);

create index if not exists ai_chat_files_owner_idx on public.ai_chat_files(owner_id, created_at desc);
create index if not exists ai_chat_message_attachments_message_idx
  on public.ai_chat_message_attachments(conversation_id, client_message_id, attachment_order);

alter table public.ai_chat_files enable row level security;
alter table public.ai_chat_message_attachments enable row level security;

create policy "users manage own ai chat files" on public.ai_chat_files for all
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "users read own ai message attachments" on public.ai_chat_message_attachments for select
  using (exists (select 1 from public.ai_chat_conversations c where c.id = conversation_id and c.user_id = auth.uid()));
create policy "users insert own ai message attachments" on public.ai_chat_message_attachments for insert
  with check (
    exists (select 1 from public.ai_chat_conversations c where c.id = conversation_id and c.user_id = auth.uid())
    and exists (select 1 from public.ai_chat_files f where f.id = file_id and f.owner_id = auth.uid())
  );
create policy "users delete own ai message attachments" on public.ai_chat_message_attachments for delete
  using (exists (select 1 from public.ai_chat_conversations c where c.id = conversation_id and c.user_id = auth.uid()));

grant select, insert, update, delete on public.ai_chat_files to authenticated, service_role;
grant select, insert, delete on public.ai_chat_message_attachments to authenticated, service_role;

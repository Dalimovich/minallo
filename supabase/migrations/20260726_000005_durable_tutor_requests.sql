alter table public.ai_chat_messages
  add column if not exists parent_client_message_id text,
  add column if not exists request_id text,
  add column if not exists completion_state text,
  add column if not exists error_code text,
  add column if not exists failure_stage text,
  add column if not exists retryable boolean,
  add column if not exists request_snapshot jsonb,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists ai_chat_messages_conversation_request_idx
  on public.ai_chat_messages (conversation_id, request_id)
  where request_id is not null;

do $$ begin
  alter table public.ai_chat_messages
    add constraint ai_chat_messages_parent_fk
    foreign key (conversation_id, parent_client_message_id)
    references public.ai_chat_messages(conversation_id, client_message_id)
    on delete cascade deferrable initially deferred;
exception when duplicate_object then null; end $$;

create table if not exists public.ai_tutor_requests (
  request_id text primary key,
  conversation_id uuid not null references public.ai_chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_client_message_id text not null,
  assistant_client_message_id text not null,
  status text not null check (status in ('queued','running','recovering','completed','interrupted','failed')),
  stage text not null default 'queued',
  partial_answer text,
  final_answer text,
  error_code text,
  retryable boolean not null default true,
  request_snapshot jsonb not null default '{}'::jsonb,
  last_event_id text,
  automatic_retry_count integer not null default 0,
  fallback_used text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, assistant_client_message_id)
);

create index if not exists ai_tutor_requests_conversation_updated_idx
  on public.ai_tutor_requests (conversation_id, updated_at desc);

do $$ begin
  alter table public.ai_tutor_requests
    add constraint ai_tutor_requests_user_message_fk
    foreign key (conversation_id, user_client_message_id)
    references public.ai_chat_messages(conversation_id, client_message_id)
    on delete cascade deferrable initially deferred;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.ai_tutor_requests
    add constraint ai_tutor_requests_assistant_message_fk
    foreign key (conversation_id, assistant_client_message_id)
    references public.ai_chat_messages(conversation_id, client_message_id)
    on delete cascade deferrable initially deferred;
exception when duplicate_object then null; end $$;

alter table public.ai_tutor_requests enable row level security;
drop policy if exists "users manage own tutor requests" on public.ai_tutor_requests;
create policy "users manage own tutor requests"
  on public.ai_tutor_requests for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.ai_tutor_requests to authenticated, service_role;

create or replace function public.create_ai_tutor_turn(
  p_conversation_id uuid,
  p_user_id uuid,
  p_user_message_id text,
  p_user_content text,
  p_assistant_message_id text,
  p_request_id text,
  p_request_snapshot jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;
  if not exists (
    select 1 from public.ai_chat_conversations
    where id = p_conversation_id and user_id = p_user_id
  ) then
    raise exception 'conversation_not_owned';
  end if;

  insert into public.ai_chat_messages (
    conversation_id, user_id, client_message_id, role, content, updated_at
  ) values (
    p_conversation_id, p_user_id, p_user_message_id, 'user', p_user_content, now()
  ) on conflict (conversation_id, client_message_id) do update
    set content = excluded.content, updated_at = now();

  insert into public.ai_chat_messages (
    conversation_id, user_id, client_message_id, role, content,
    parent_client_message_id, request_id, completion_state, retryable,
    request_snapshot, updated_at
  ) values (
    p_conversation_id, p_user_id, p_assistant_message_id, 'assistant', '',
    p_user_message_id, p_request_id, 'pending', true,
    coalesce(p_request_snapshot, '{}'::jsonb), now()
  ) on conflict (conversation_id, client_message_id) do nothing;

  insert into public.ai_tutor_requests (
    request_id, conversation_id, user_id, user_client_message_id,
    assistant_client_message_id, status, stage, request_snapshot, updated_at
  ) values (
    p_request_id, p_conversation_id, p_user_id, p_user_message_id,
    p_assistant_message_id, 'queued', 'queued', coalesce(p_request_snapshot, '{}'::jsonb), now()
  ) on conflict (request_id) do nothing;
end;
$$;

revoke all on function public.create_ai_tutor_turn(uuid,uuid,text,text,text,text,jsonb) from public;
grant execute on function public.create_ai_tutor_turn(uuid,uuid,text,text,text,text,jsonb) to service_role;

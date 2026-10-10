-- Bind long-running coverage jobs to their durable tutor request and assistant row.
alter table public.complete_document_jobs
  add column if not exists conversation_id uuid references public.ai_chat_conversations(id) on delete set null,
  add column if not exists user_message_id text,
  add column if not exists assistant_message_id text,
  add column if not exists request_id text,
  add column if not exists current_stage text not null default 'queued',
  add column if not exists last_event_id uuid,
  add column if not exists checkpoint_id uuid,
  add column if not exists structural_checkpoint jsonb not null default '{}'::jsonb;

alter table public.ai_tutor_requests
  add column if not exists scoped_job_id uuid references public.complete_document_jobs(id) on delete set null;

alter table public.ai_chat_messages
  add column if not exists scoped_job_id uuid references public.complete_document_jobs(id) on delete set null;

create index if not exists complete_document_jobs_request_idx
  on public.complete_document_jobs(user_id, request_id)
  where request_id is not null;

create index if not exists ai_chat_messages_scoped_job_idx
  on public.ai_chat_messages(scoped_job_id)
  where scoped_job_id is not null;

create or replace function public.bind_scoped_job_to_tutor_turn(
  p_job_id uuid,
  p_user_id uuid,
  p_request_id text,
  p_conversation_id uuid,
  p_user_message_id text,
  p_assistant_message_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'not_authorized';
  end if;

  update public.complete_document_jobs set
    conversation_id = p_conversation_id,
    user_message_id = p_user_message_id,
    assistant_message_id = p_assistant_message_id,
    request_id = p_request_id,
    current_stage = 'structural_discovery',
    updated_at = now()
  where id = p_job_id and user_id = p_user_id;

  if not found then raise exception 'scoped_job_not_owned'; end if;

  update public.ai_tutor_requests set
    scoped_job_id = p_job_id,
    status = 'running',
    stage = 'structural_discovery',
    updated_at = now()
  where request_id = p_request_id and user_id = p_user_id;

  update public.ai_chat_messages set
    scoped_job_id = p_job_id,
    completion_state = 'recovering',
    failure_stage = 'structural_discovery',
    updated_at = now()
  where conversation_id = p_conversation_id
    and client_message_id = p_assistant_message_id
    and user_id = p_user_id;
end;
$$;

revoke all on function public.bind_scoped_job_to_tutor_turn(uuid,uuid,text,uuid,text,text) from public;
grant execute on function public.bind_scoped_job_to_tutor_turn(uuid,uuid,text,uuid,text,text) to service_role;

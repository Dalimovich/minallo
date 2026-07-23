-- Durable, tenant-scoped state for grounded multi-turn tutoring.
create table if not exists public.ai_tutor_states (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  course_id text not null,
  generation bigint not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

create index if not exists ai_tutor_states_course_idx
  on public.ai_tutor_states (user_id, course_id);

alter table public.ai_tutor_states enable row level security;

drop policy if exists "users manage own tutor state" on public.ai_tutor_states;
create policy "users manage own tutor state"
  on public.ai_tutor_states for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.ai_tutor_states
  to authenticated, service_role;

create or replace function public.claim_ai_tutor_generation(
  p_user_id uuid,
  p_conversation_id text,
  p_course_id text,
  p_generation bigint
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  accepted boolean;
begin
  insert into public.ai_tutor_states (
    user_id, conversation_id, course_id, generation
  ) values (
    p_user_id, p_conversation_id, p_course_id, p_generation
  )
  on conflict (user_id, conversation_id) do update
    set generation = greatest(ai_tutor_states.generation, excluded.generation),
        course_id = excluded.course_id,
        updated_at = now();

  select generation = p_generation into accepted
  from public.ai_tutor_states
  where user_id = p_user_id and conversation_id = p_conversation_id;
  return coalesce(accepted, false);
end;
$$;

revoke all on function public.claim_ai_tutor_generation(uuid, text, text, bigint)
  from public;
grant execute on function public.claim_ai_tutor_generation(uuid, text, text, bigint)
  to service_role;

create or replace function public.save_ai_tutor_state(
  p_user_id uuid,
  p_conversation_id text,
  p_course_id text,
  p_generation bigint,
  p_state jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_tutor_states
  set course_id = p_course_id,
      state = p_state,
      updated_at = now()
  where user_id = p_user_id
    and conversation_id = p_conversation_id
    and generation = p_generation;
  return found;
end;
$$;

revoke all on function public.save_ai_tutor_state(uuid, text, text, bigint, jsonb)
  from public;
grant execute on function public.save_ai_tutor_state(uuid, text, text, bigint, jsonb)
  to service_role;

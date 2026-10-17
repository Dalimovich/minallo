-- German Exam Engine — pre-generated, validated task inventory.
--
-- Official telc parts (Hören/Lesen/Sprachbausteine/Schreiben) are served from
-- a stock of already-generated, already-validated tasks so the learner never
-- waits for live LLM generation. A background job in python-ai tops the stock
-- up. General Grammatik/Wortschatz practice is NOT stocked (stays adaptive).
--
-- Service-role only: `content` holds answer keys, so RLS is enabled with NO
-- policies — the browser can never read this table directly.

create table if not exists public.german_exam_inventory (
  id                 uuid        primary key default gen_random_uuid(),
  profile_id         text        not null,
  profile_version    integer     not null,
  module             text        not null check (module in
                       ('listening', 'reading', 'writing', 'speaking', 'language_elements')),
  part_id            text        not null,
  topic_id           text        not null,
  -- The full generate envelope (schemaVersion/exam/part/topic/content/validation).
  content            jsonb       not null,
  quality_status     text        not null default 'approved'
                       check (quality_status in ('approved', 'rejected', 'pending')),
  quality_score      numeric,
  generation_source  text        not null default 'background',
  generator_revision text,
  active             boolean     not null default true,
  used_count         integer     not null default 0,
  created_at         timestamptz not null default now()
);

create index if not exists idx_german_exam_inventory_lookup
  on public.german_exam_inventory (profile_id, module, part_id, active, quality_status);

-- Which learner has already been served which stocked task (rotation).
create table if not exists public.german_exam_inventory_served (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  inventory_id  uuid        not null references public.german_exam_inventory(id) on delete cascade,
  profile_id    text        not null,
  module        text        not null,
  part_id       text        not null,
  served_at     timestamptz not null default now(),
  primary key (user_id, inventory_id)
);

create index if not exists idx_german_exam_inventory_served_user_part
  on public.german_exam_inventory_served (user_id, profile_id, module, part_id);

alter table public.german_exam_inventory enable row level security;
alter table public.german_exam_inventory_served enable row level security;

-- Atomically pick one approved, active, current-version task the learner has
-- not seen (least-served first, random tie-break), record that they were
-- served it, and bump used_count. `skip locked` keeps concurrent callers from
-- fighting over the same row. Returns zero rows when the learner has
-- exhausted the stock (caller falls back to live generation).
create or replace function public.german_exam_inventory_take(
  p_user_id uuid,
  p_profile_id text,
  p_module text,
  p_part_id text,
  p_profile_version integer
) returns table (
  id uuid,
  topic_id text,
  content jsonb,
  remaining_unserved integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_remaining integer;
begin
  select i.id into v_id
  from public.german_exam_inventory i
  where i.profile_id = p_profile_id
    and i.module = p_module
    and i.part_id = p_part_id
    and i.profile_version = p_profile_version
    and i.active
    and i.quality_status = 'approved'
    and not exists (
      select 1 from public.german_exam_inventory_served s
      where s.user_id = p_user_id and s.inventory_id = i.id
    )
  order by i.used_count asc, random()
  limit 1
  for update of i skip locked;

  if v_id is null then
    return;
  end if;

  insert into public.german_exam_inventory_served (user_id, inventory_id, profile_id, module, part_id)
  values (p_user_id, v_id, p_profile_id, p_module, p_part_id)
  on conflict do nothing;

  update public.german_exam_inventory set used_count = used_count + 1 where german_exam_inventory.id = v_id;

  select count(*)::integer into v_remaining
  from public.german_exam_inventory i
  where i.profile_id = p_profile_id
    and i.module = p_module
    and i.part_id = p_part_id
    and i.profile_version = p_profile_version
    and i.active
    and i.quality_status = 'approved'
    and not exists (
      select 1 from public.german_exam_inventory_served s
      where s.user_id = p_user_id and s.inventory_id = i.id
    );

  return query
    select i.id, i.topic_id, i.content, v_remaining
    from public.german_exam_inventory i
    where i.id = v_id;
end;
$$;

revoke all on function public.german_exam_inventory_take(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.german_exam_inventory_take(uuid, text, text, text, integer) to service_role;

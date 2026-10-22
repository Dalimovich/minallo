-- =============================================================================
-- profiles.university_* columns + crowd-sourced suggestions table.
--
-- The onboarding modal lets students pick their university from the
-- Hochschulkompass registry (frontend/js/data/hochschulen.ts) and we want to
-- persist enough metadata to filter / segment by state and type later.
--
-- The `suggestions` table powers crowd-sourced enrichment of the Vertiefung
-- and course-name dropdowns: when the same value (case-insensitive) is
-- submitted by ≥ 5 distinct users, it becomes `approved` and shows up in
-- everyone's dropdown automatically. Writes happen via the RPC below so RLS
-- can stay strict — anon/authenticated users cannot mutate the table
-- directly.
-- =============================================================================

-- ── profiles: extra university columns ────────────────────────────────────
alter table public.profiles
  add column if not exists university_name  text,
  add column if not exists university_state text,
  add column if not exists university_type  text;

-- ── suggestions table ─────────────────────────────────────────────────────
create table if not exists public.suggestions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('vertiefung','course')),
  parent      text not null default '*',
  value       text not null,
  normalized  text not null,
  count       integer not null default 1,
  approved    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (kind, parent, normalized)
);

create index if not exists idx_suggestions_kind_parent_approved
  on public.suggestions (kind, parent, approved);

-- ── RPC: atomic upsert + auto-approve at threshold ────────────────────────
create or replace function public.suggestion_submit(
  p_kind text,
  p_parent text,
  p_value text,
  p_threshold integer default 5
) returns table (id uuid, count integer, approved boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value      text := trim(p_value);
  v_normalized text := lower(v_value);
  v_parent     text := coalesce(nullif(trim(p_parent), ''), '*');
begin
  if v_normalized = '' then
    raise exception 'suggestion_submit: value cannot be empty';
  end if;
  if char_length(v_value) > 120 then
    raise exception 'suggestion_submit: value too long';
  end if;
  if p_kind not in ('vertiefung','course') then
    raise exception 'suggestion_submit: invalid kind %', p_kind;
  end if;

  insert into public.suggestions (kind, parent, value, normalized)
  values (p_kind, v_parent, v_value, v_normalized)
  on conflict (kind, parent, normalized) do update
    set count      = public.suggestions.count + 1,
        updated_at = now(),
        approved   = public.suggestions.approved
                  or (public.suggestions.count + 1 >= coalesce(p_threshold, 5));

  return query
    select s.id, s.count, s.approved
    from public.suggestions s
    where s.kind = p_kind
      and s.parent = v_parent
      and s.normalized = v_normalized;
end$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.suggestions enable row level security;

drop policy if exists "suggestions readable when approved" on public.suggestions;
create policy "suggestions readable when approved"
  on public.suggestions
  for select
  to authenticated, anon
  using (approved = true);

-- Lock down direct writes; only the RPC (security definer) and the service
-- role may mutate rows.
revoke insert, update, delete on public.suggestions from anon, authenticated;
grant  execute on function public.suggestion_submit(text, text, text, integer)
  to authenticated;

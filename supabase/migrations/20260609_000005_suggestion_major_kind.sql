-- Allow crowd-approved study programme / major suggestions to use the same
-- 5-user suggestion pipeline as Vertiefung and course names.

do $$
declare
  v_constraint_name text;
begin
  select conname
    into v_constraint_name
  from pg_constraint
  where conrelid = 'public.suggestions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%kind%'
    and pg_get_constraintdef(oid) ilike '%vertiefung%'
    and pg_get_constraintdef(oid) ilike '%course%'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.suggestions drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.suggestions
  add constraint suggestions_kind_check
  check (kind in ('vertiefung', 'course', 'major'));

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
  if p_kind not in ('vertiefung','course','major') then
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

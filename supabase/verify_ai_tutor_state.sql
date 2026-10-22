begin;

do $test$
declare
  uid uuid;
  conv text := 'codex-migration-smoke-' || gen_random_uuid()::text;
begin
  select id into uid from auth.users limit 1;
  if uid is null then
    raise exception 'no testable auth user';
  end if;
  if not public.claim_ai_tutor_generation(uid, conv, 'migration-smoke', 1) then
    raise exception 'generation 1 claim failed';
  end if;
  if public.claim_ai_tutor_generation(uid, conv, 'migration-smoke', 0) then
    raise exception 'stale generation was accepted';
  end if;
  if not public.save_ai_tutor_state(
    uid, conv, 'migration-smoke', 1, '{"verified":true}'::jsonb
  ) then
    raise exception 'current generation save failed';
  end if;
end
$test$;

rollback;
select 'atomic_contract_ok' as result;

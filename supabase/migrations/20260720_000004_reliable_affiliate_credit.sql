-- Provider webhooks call these functions directly. They are idempotent, so a
-- webhook retry can never add a second €3 commission for the same referral.
create or replace function public.record_affiliate_trial(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.affiliate_referrals
     set trial_started_at = coalesce(trial_started_at, now())
   where referred_user_id = p_user_id;
$$;

create or replace function public.record_affiliate_payment(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  referral_row public.affiliate_referrals%rowtype;
begin
  update public.affiliate_referrals
     set subscribed_at = coalesce(subscribed_at, now())
   where referred_user_id = p_user_id
   returning * into referral_row;

  if referral_row.id is not null then
    insert into public.affiliate_commissions
      (affiliate_user_id, referral_id, amount_cents, currency, earned_at)
    values
      (referral_row.affiliate_user_id, referral_row.id, 300, 'EUR', now())
    on conflict (referral_id) do nothing;
  end if;
end;
$$;

revoke all on function public.record_affiliate_trial(uuid) from public, anon, authenticated;
revoke all on function public.record_affiliate_payment(uuid) from public, anon, authenticated;
grant execute on function public.record_affiliate_trial(uuid) to service_role;
grant execute on function public.record_affiliate_payment(uuid) to service_role;

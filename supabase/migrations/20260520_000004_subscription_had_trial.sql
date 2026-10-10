-- Track whether a subscription row has consumed its 7-day free trial.
-- Read by create-checkout to force noTrial=true on a second checkout from the
-- same user_id, complementing the device-hash ledger.
alter table public.subscriptions
  add column if not exists had_trial boolean not null default false;

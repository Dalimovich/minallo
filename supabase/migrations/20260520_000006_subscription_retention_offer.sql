-- One-time retention discount tracking.
-- A user can redeem the €3.00-off-for-3-months "renewal" coupon at most
-- once. The frontend gates via localStorage, but the server enforces the
-- single-use rule via these columns so clearing storage / using a new
-- device doesn't allow re-claiming.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS retention_offer_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retention_offer_used_at timestamptz;

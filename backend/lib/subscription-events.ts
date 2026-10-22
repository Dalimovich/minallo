// Best-effort recorder for the subscription_events history table.
//
// Called from the Stripe and PayPal webhooks. Every call is wrapped so a write
// failure (e.g. the migration hasn't been applied yet) can NEVER break webhook
// processing — analytics history is non-critical relative to keeping the
// subscription row itself correct.

import { supaRequest } from './supabase-admin';

export type SubEventType =
  | 'trial_started'
  | 'paid'
  | 'converted'
  | 'renewed'
  | 'cancelled'
  | 'expired';

export interface SubEventInput {
  user_id?: string | null;
  provider: 'stripe' | 'paypal';
  event_type: SubEventType;
  subscription_id?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  period_start?: string | null;
  period_end?: string | null;
}

export async function recordSubEvent(serviceKey: string, e: SubEventInput): Promise<void> {
  if (!e.user_id) return; // no user → can't attribute; skip silently
  try {
    await supaRequest(
      'POST',
      'subscription_events',
      {
        user_id: e.user_id,
        provider: e.provider,
        event_type: e.event_type,
        subscription_id: e.subscription_id || null,
        amount_cents: typeof e.amount_cents === 'number' ? e.amount_cents : null,
        currency: e.currency || null,
        period_start: e.period_start || null,
        period_end: e.period_end || null,
        created_at: new Date().toISOString()
      },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
  } catch {
    /* analytics is best-effort — never throw into webhook processing */
  }
}

interface UserIdRow { user_id?: string; status?: string }

/** Resolve a user_id (and current status) from a Stripe customer id. */
export async function lookupByStripeCustomer(
  serviceKey: string,
  customerId: string
): Promise<{ userId: string | null; status: string | null }> {
  try {
    const res = await supaRequest<UserIdRow[]>(
      'GET',
      'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(customerId) +
        '&select=user_id,status&limit=1',
      null,
      serviceKey
    );
    const row = Array.isArray(res.body) ? res.body[0] : undefined;
    return { userId: row?.user_id || null, status: row?.status || null };
  } catch {
    return { userId: null, status: null };
  }
}

/** Resolve a user_id from a PayPal subscription id. */
export async function lookupByPaypalSub(
  serviceKey: string,
  subId: string
): Promise<string | null> {
  try {
    const res = await supaRequest<UserIdRow[]>(
      'GET',
      'subscriptions?paypal_subscription_id=eq.' + encodeURIComponent(subId) +
        '&select=user_id&limit=1',
      null,
      serviceKey
    );
    const row = Array.isArray(res.body) ? res.body[0] : undefined;
    return row?.user_id || null;
  } catch {
    return null;
  }
}

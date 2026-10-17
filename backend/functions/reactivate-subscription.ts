import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost } from '../lib/stripe';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface SubscriptionRow {
  user_id: string;
  plan?: string;
  status?: string;
  expires_at?: string | null;
  stripe_subscription_id?: string | null;
  paypal_subscription_id?: string | null;
  cancel_at_period_end?: boolean;
}

interface StripeUpdateResponse {
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  error?: { message?: string };
}

function isoOrNull(unixSeconds: number | undefined): string | null {
  return typeof unixSeconds === 'number' && Number.isFinite(unixSeconds)
    ? new Date(unixSeconds * 1000).toISOString()
    : null;
}

// Un-cancel a Stripe subscription that was previously scheduled to end at
// period end. PayPal is intentionally not supported: once /cancel has been
// posted to PayPal the subscription is dead on their side, and we don't want
// to silently create a new one without the consent flow.
export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  const subRes = await supaRequest<SubscriptionRow[]>(
    'GET',
    'subscriptions?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=user_id,plan,status,expires_at,stripe_subscription_id,paypal_subscription_id,cancel_at_period_end&limit=1',
    null,
    serviceKey
  );
  const sub = Array.isArray(subRes.body) ? subRes.body[0] : undefined;
  if (!sub) return fail(404, 'No subscription found');
  if (!sub.cancel_at_period_end) return fail(400, 'Subscription is not scheduled to cancel');
  if (!sub.stripe_subscription_id) {
    return fail(400, 'Reactivation is only supported for Stripe subscriptions. Please subscribe again.');
  }

  try {
    requireEnv('STRIPE_SECRET_KEY');
    const params = new URLSearchParams();
    params.append('cancel_at_period_end', 'false');
    const result = await stripePost<StripeUpdateResponse>(
      '/v1/subscriptions/' + encodeURIComponent(sub.stripe_subscription_id),
      params
    );
    if (result.status < 200 || result.status >= 300) {
      return fail(result.status, result.body.error?.message || 'Stripe reactivation failed');
    }

    const nowIso = new Date().toISOString();
    const periodEnd = isoOrNull(result.body.current_period_end) || sub.expires_at || nowIso;
    const writeRes = await supaRequest(
      'PATCH',
      'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
      {
        status: 'active',
        expires_at: periodEnd,
        cancel_at_period_end: false,
        updated_at: nowIso
      },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
    if (writeRes.status < 200 || writeRes.status >= 300) return fail(500, 'Could not save reactivation');
    return jsonResponse(200, { ok: true, status: 'active', expires_at: periodEnd });
  } catch {
    return fail(500, 'Could not reactivate subscription');
  }
};

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost, stripeGet } from '../lib/stripe';
import { paypalOauthToken, paypalRequest } from '../lib/paypal';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface SubscriptionRow {
  user_id: string;
  plan?: string;
  status?: string;
  stripe_subscription_id?: string | null;
  paypal_subscription_id?: string | null;
}

interface StripeSubscription {
  current_period_end?: number;
  error?: { message?: string };
}

interface BillingError {
  error?: { message?: string };
  message?: string;
}

function isoOrNull(unixSeconds: number | undefined): string | null {
  return typeof unixSeconds === 'number' && Number.isFinite(unixSeconds)
    ? new Date(unixSeconds * 1000).toISOString()
    : null;
}

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
      '&select=user_id,plan,status,stripe_subscription_id,paypal_subscription_id&limit=1',
    null,
    serviceKey
  );
  const sub = Array.isArray(subRes.body) ? subRes.body[0] : undefined;
  if (!sub || sub.plan !== 'pro') return fail(404, 'No Pro subscription found');
  if (sub.status !== 'paused') return fail(400, 'Subscription is not paused');

  try {
    let expiresAt: string | null = null;
    if (sub.stripe_subscription_id) {
      requireEnv('STRIPE_SECRET_KEY');
      const params = new URLSearchParams();
      params.append('pause_collection', '');
      const result = await stripePost<BillingError>(
        '/v1/subscriptions/' + encodeURIComponent(sub.stripe_subscription_id),
        params
      );
      if (result.status < 200 || result.status >= 300) {
        return fail(result.status, result.body.error?.message || 'Stripe resume failed');
      }
      const refreshed = await stripeGet<StripeSubscription>(
        '/v1/subscriptions/' + encodeURIComponent(sub.stripe_subscription_id)
      );
      if (refreshed.status >= 200 && refreshed.status < 300) {
        expiresAt = isoOrNull(refreshed.body.current_period_end);
      }
    } else if (sub.paypal_subscription_id) {
      const paypalToken = await paypalOauthToken();
      const result = await paypalRequest<BillingError>(
        'POST',
        '/v1/billing/subscriptions/' + encodeURIComponent(sub.paypal_subscription_id) + '/activate',
        paypalToken,
        { reason: 'Student resumed subscription' }
      );
      if (result.status < 200 || result.status >= 300) {
        return fail(result.status, result.body?.message || 'PayPal resume failed');
      }
      expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    }

    if (!expiresAt) expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    const writeRes = await supaRequest(
      'PATCH',
      'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
      {
        status: 'active',
        expires_at: expiresAt,
        pause_started_at: null,
        pause_resumes_at: null,
        pause_reason: null,
        updated_at: new Date().toISOString()
      },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
    if (writeRes.status < 200 || writeRes.status >= 300) return fail(500, 'Could not save resume');
    return jsonResponse(200, { ok: true, status: 'active', expires_at: expiresAt });
  } catch {
    return fail(500, 'Could not resume subscription');
  }
};

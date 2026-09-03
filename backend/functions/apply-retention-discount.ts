import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost, stripeGet } from '../lib/stripe';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface SubscriptionRow {
  user_id: string;
  plan?: string;
  status?: string;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  retention_offer_used?: boolean | null;
}

interface StripeListSubscriptions {
  data?: Array<{ id: string; status: string }>;
}

interface BillingError {
  error?: { message?: string };
  message?: string;
}

interface StripeUpdateResponse extends BillingError {
  id?: string;
  discount?: { coupon?: { id?: string } } | null;
}

// Coupon configured in Stripe Dashboard: €3.00 off, duration=once
// (applies to the next single invoice only). The ID is what Stripe
// matches on; the "name" field is just for display.
const RETENTION_COUPON_ID = 'retention-1mo';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  // Load subscription. Must be Pro on Stripe (PayPal coupons need a separate
  // flow; not supported here).
  const subRes = await supaRequest<SubscriptionRow[]>(
    'GET',
    'subscriptions?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=user_id,plan,status,stripe_customer_id,stripe_subscription_id,retention_offer_used&limit=1',
    null,
    serviceKey
  );
  const sub = Array.isArray(subRes.body) ? subRes.body[0] : undefined;
  if (!sub || sub.plan !== 'pro') return fail(404, 'No Pro subscription found');
  if (sub.retention_offer_used) {
    return fail(409, 'Retention discount already used');
  }
  if (!sub.stripe_subscription_id && !sub.stripe_customer_id) {
    return fail(400, 'Retention discount is only available for Stripe subscriptions');
  }

  try {
    requireEnv('STRIPE_SECRET_KEY');

    // Some legacy rows never recorded the subscription id (only the
    // customer id). Look it up on the fly from Stripe in that case.
    let stripeSubId = sub.stripe_subscription_id;
    if (!stripeSubId && sub.stripe_customer_id) {
      const listRes = await stripeGet<StripeListSubscriptions>(
        '/v1/subscriptions?customer=' + encodeURIComponent(sub.stripe_customer_id) +
          '&status=all&limit=10'
      );
      if (listRes.status >= 200 && listRes.status < 300) {
        const items = listRes.body.data || [];
        // Accept any subscription that still has a future billing cycle —
        // i.e. anything except hard-terminated ones. Stripe returns them
        // newest-first so the first match is the most relevant.
        const usable = items.find(
          (s) => s.status !== 'canceled' && s.status !== 'incomplete_expired'
        );
        if (usable) stripeSubId = usable.id;
      } else {
        return fail(502, 'Stripe lookup failed (' + listRes.status + ')');
      }
    }
    if (!stripeSubId) {
      return fail(404, 'No active Stripe subscription to discount (customer=' +
        (sub.stripe_customer_id || 'n/a') + ')');
    }

    const params = new URLSearchParams();
    params.append('coupon', RETENTION_COUPON_ID);
    // If the user had a scheduled cancellation, undo it — they chose to stay.
    params.append('cancel_at_period_end', 'false');
    const result = await stripePost<StripeUpdateResponse>(
      '/v1/subscriptions/' + encodeURIComponent(stripeSubId),
      params
    );
    if (result.status < 200 || result.status >= 300) {
      return fail(result.status, result.body.error?.message || 'Could not apply discount');
    }

    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {
      retention_offer_used: true,
      retention_offer_used_at: nowIso,
      cancel_at_period_end: false,
      updated_at: nowIso
    };
    // Backfill the subscription id if we resolved it from the customer.
    if (!sub.stripe_subscription_id && stripeSubId) {
      patch.stripe_subscription_id = stripeSubId;
    }
    const writeRes = await supaRequest(
      'PATCH',
      'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
      patch,
      serviceKey,
      { Prefer: 'return=minimal' }
    );
    if (writeRes.status < 200 || writeRes.status >= 300) {
      // Discount applied in Stripe; DB flag failed. Surface it so we can
      // reconcile manually rather than silently letting it be claimed twice.
      return fail(500, 'Discount applied but could not record redemption');
    }
    return jsonResponse(200, { ok: true, coupon: RETENTION_COUPON_ID });
  } catch {
    return fail(500, 'Could not apply retention discount');
  }
};

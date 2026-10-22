import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost } from '../lib/stripe';
import { paypalOauthToken, paypalRequest } from '../lib/paypal';
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
}

interface BillingError {
  error?: { message?: string };
  message?: string;
}

interface StripeCancelResponse extends BillingError {
  current_period_end?: number;
  cancel_at_period_end?: boolean;
}

interface PaypalSubscriptionResource {
  id?: string;
  status?: string;
  billing_info?: {
    next_billing_time?: string;
  };
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
      '&select=user_id,plan,status,expires_at,stripe_subscription_id,paypal_subscription_id&limit=1',
    null,
    serviceKey
  );
  const sub = Array.isArray(subRes.body) ? subRes.body[0] : undefined;
  if (!sub || sub.plan !== 'pro') return fail(404, 'No Pro subscription found');
  if (sub.status === 'cancelled') return jsonResponse(200, { ok: true, status: 'cancelled' });

  try {
    // Stripe and PayPal differ in cancellation semantics:
    //   Stripe: cancel_at_period_end=true → user keeps Pro until current
    //     period end, then customer.subscription.deleted fires and the
    //     webhook flips them to cancelled/free. We must NOT revoke access
    //     immediately or we'd take money for time we don't deliver.
    //   PayPal: /cancel is immediate. Access ends now.
    const nowIso = new Date().toISOString();
    if (sub.stripe_subscription_id) {
      requireEnv('STRIPE_SECRET_KEY');
      const params = new URLSearchParams();
      params.append('cancel_at_period_end', 'true');
      const result = await stripePost<StripeCancelResponse>(
        '/v1/subscriptions/' + encodeURIComponent(sub.stripe_subscription_id),
        params
      );
      if (result.status < 200 || result.status >= 300) {
        return fail(result.status, result.body.error?.message || 'Stripe cancellation failed');
      }
      // Keep Pro until period end. Persist the scheduled-cancel flag so the
      // UI can show "ends on …" instead of "Active" without ambiguity.
      const periodEnd = isoOrNull(result.body.current_period_end) || sub.expires_at || nowIso;
      const writeRes = await supaRequest(
        'PATCH',
        'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
        {
          status: 'active',
          expires_at: periodEnd,
          cancel_at_period_end: true,
          pause_started_at: null,
          pause_resumes_at: null,
          pause_reason: null,
          updated_at: nowIso
        },
        serviceKey,
        { Prefer: 'return=minimal' }
      );
      if (writeRes.status < 200 || writeRes.status >= 300) return fail(500, 'Could not save cancellation');
      return jsonResponse(200, { ok: true, status: 'scheduled', expires_at: periodEnd });
    }

    if (sub.paypal_subscription_id) {
      const paypalToken = await paypalOauthToken();

      // Read the live PayPal subscription FIRST so we know when the current
      // paid (or trial) period ends. next_billing_time is the next charge
      // date — for a trial it's trial_end, for a paid month it's the end of
      // the current cycle. We use this as expires_at so the user keeps Pro
      // for the time they've already paid for / been promised, matching the
      // Stripe cancel_at_period_end behaviour.
      const getRes = await paypalRequest<PaypalSubscriptionResource>(
        'GET',
        '/v1/billing/subscriptions/' + encodeURIComponent(sub.paypal_subscription_id),
        paypalToken
      );
      const nextBilling = getRes.body?.billing_info?.next_billing_time;
      const periodEnd =
        (nextBilling && Number.isFinite(Date.parse(nextBilling))
          ? new Date(nextBilling).toISOString()
          : null) ||
        sub.expires_at ||
        nowIso;

      // Now cancel at PayPal so no further billing fires. PayPal /cancel is
      // one-way and immediate from PayPal's accounting POV (no refunds), but
      // we keep the user as Pro in our DB until periodEnd because they paid
      // for that time.
      const cancelRes = await paypalRequest<BillingError>(
        'POST',
        '/v1/billing/subscriptions/' + encodeURIComponent(sub.paypal_subscription_id) + '/cancel',
        paypalToken,
        { reason: 'Student cancelled subscription' }
      );
      if (cancelRes.status < 200 || cancelRes.status >= 300) {
        return fail(cancelRes.status, cancelRes.body?.message || 'PayPal cancellation failed');
      }

      const writeRes = await supaRequest(
        'PATCH',
        'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
        {
          status: 'active',
          expires_at: periodEnd,
          cancel_at_period_end: true,
          pause_started_at: null,
          pause_resumes_at: null,
          pause_reason: null,
          updated_at: nowIso
        },
        serviceKey,
        { Prefer: 'return=minimal' }
      );
      if (writeRes.status < 200 || writeRes.status >= 300) return fail(500, 'Could not save cancellation');
      return jsonResponse(200, { ok: true, status: 'scheduled', expires_at: periodEnd });
    }

    // DB-managed Pro (no provider on the row): nothing external to cancel,
    // revoke immediately.
    const writeRes = await supaRequest(
      'PATCH',
      'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
      {
        plan: 'free',
        status: 'cancelled',
        expires_at: nowIso,
        pause_started_at: null,
        pause_resumes_at: null,
        pause_reason: null,
        updated_at: nowIso
      },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
    if (writeRes.status < 200 || writeRes.status >= 300) return fail(500, 'Could not save cancellation');
    return jsonResponse(200, { ok: true, status: 'cancelled', expires_at: nowIso });
  } catch {
    return fail(500, 'Could not cancel subscription');
  }
};


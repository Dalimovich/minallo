import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripeGet } from '../lib/stripe';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { recordDeviceTrial } from '../lib/trial-device';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeSession {
  status?: string;
  payment_status?: string;
  subscription?: string | null;
  customer?: string | null;
  metadata?: { user_id?: string; no_trial?: string; trial_device_hash?: string };
  error?: { message?: string };
}

interface StripeSubscription {
  current_period_end?: number;
  trial_end?: number | null;
}

interface SubscriptionRow {
  plan: string;
  status: string;
  stripe_subscription_id?: string | null;
  stripe_customer_id?: string | null;
  expires_at?: string | null;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const callerUser = await verifySupabaseToken(token);
  if (!callerUser || !callerUser.id) return fail(401, 'Unauthorized');

  let sessionId: string | undefined;
  try {
    const parsed = JSON.parse(event.body || '{}') as Record<string, unknown>;
    sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  } catch { return fail(400, 'Invalid body'); }
  if (!sessionId) return fail(400, 'Missing sessionId');

  try {
    const result = await stripeGet<StripeSession>('/v1/checkout/sessions/' + sessionId);
    const session = result.body;
    if (session.error) return fail(400, session.error.message || 'Stripe error');

    const metaUserId = session.metadata && session.metadata.user_id;
    if (!metaUserId || metaUserId !== callerUser.id) return fail(403, 'Session does not belong to this user');

    const validStatuses = ['complete', 'paid'];
    const paymentOk = (session.status && validStatuses.includes(session.status)) ||
      session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paymentOk) return fail(400, 'Payment not completed');

    const userId = callerUser.id;
    const currentSubRes = await supaRequest<SubscriptionRow[]>(
      'GET',
      'subscriptions?user_id=eq.' + encodeURIComponent(userId) +
        '&select=plan,status,stripe_subscription_id,stripe_customer_id,expires_at&limit=1',
      null, serviceKey
    );
    const currentSub = Array.isArray(currentSubRes.body) ? currentSubRes.body[0] : undefined;
    const sameStripeSubscription = session.subscription && currentSub &&
      currentSub.stripe_subscription_id === session.subscription;
    const sameStripeCustomer = !session.subscription && session.customer && currentSub &&
      currentSub.stripe_customer_id === session.customer;
    if (currentSub && currentSub.status === 'active' && (sameStripeSubscription || sameStripeCustomer)) {
      return jsonResponse(200, { ok: true, alreadyProcessed: true, expires_at: currentSub.expires_at || null });
    }

    const isTrialCheckout =
      session.payment_status === 'no_payment_required' && session.metadata?.no_trial !== 'true';

    // Pull the real period boundary from Stripe so we don't drift from the
    // billing cycle. The webhook also writes this on customer.subscription.*
    // events; this read is belt-and-braces for the success-redirect path.
    let expires: string | null = null;
    if (session.subscription) {
      try {
        const subRes = await stripeGet<StripeSubscription>(
          '/v1/subscriptions/' + encodeURIComponent(session.subscription)
        );
        if (subRes.status >= 200 && subRes.status < 300) {
          const target = isTrialCheckout
            ? subRes.body.trial_end || subRes.body.current_period_end
            : subRes.body.current_period_end;
          if (typeof target === 'number' && Number.isFinite(target)) {
            expires = new Date(target * 1000).toISOString();
          }
        }
      } catch { /* fall back to default below */ }
    }
    if (!expires) {
      expires = new Date(
        Date.now() + (isTrialCheckout ? 8 : 31) * 24 * 60 * 60 * 1000
      ).toISOString();
    }
    const writeRes = await supaRequest('POST', 'subscriptions?on_conflict=user_id',
      {
        id: userId, user_id: userId, plan: 'pro', status: isTrialCheckout ? 'trialing' : 'active',
        stripe_subscription_id: session.subscription || null,
        stripe_customer_id: session.customer || null,
        expires_at: expires, had_trial: isTrialCheckout,
        updated_at: new Date().toISOString()
      },
      serviceKey, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (writeRes.status < 200 || writeRes.status >= 300) {
      // The DB write is the source of truth for Pro entitlement. If it fails
      // we MUST NOT return ok:true — the frontend would locally flip to Pro
      // while every backend-gated AI call still saw the user as free. The
      // webhook is the safety net here: it will retry the same row on the
      // next customer.subscription.* event.
      console.error('[verify-payment] subscriptions upsert failed:', writeRes.status, writeRes.body);
      return fail(502, 'Could not record subscription — please refresh in a moment.');
    }

    if (isTrialCheckout && session.metadata?.trial_device_hash) {
      await recordDeviceTrial(
        serviceKey,
        session.metadata.trial_device_hash,
        userId,
        session.subscription || null,
        'stripe'
      );
    }

    return jsonResponse(200, { ok: true, expires_at: expires, had_trial: isTrialCheckout });
  } catch {
    return fail(500, 'Could not verify payment');
  }
};

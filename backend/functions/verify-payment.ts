import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripeGet } from '../lib/stripe';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeSession {
  status?: string;
  payment_status?: string;
  subscription?: string | null;
  customer?: string | null;
  metadata?: { user_id?: string };
  error?: { message?: string };
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

    const expires = new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString();
    await supaRequest('POST', 'subscriptions?on_conflict=user_id',
      {
        id: userId, user_id: userId, plan: 'pro', status: 'active',
        stripe_subscription_id: session.subscription || null,
        stripe_customer_id: session.customer || null,
        expires_at: expires, had_trial: true,
        updated_at: new Date().toISOString()
      },
      serviceKey, { Prefer: 'resolution=merge-duplicates,return=minimal' });

    return jsonResponse(200, { ok: true, expires_at: expires });
  } catch {
    return fail(500, 'Could not verify payment');
  }
};

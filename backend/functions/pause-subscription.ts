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
  stripe_subscription_id?: string | null;
  paypal_subscription_id?: string | null;
}

interface BillingError {
  error?: { message?: string };
  message?: string;
}

const MIN_PAUSE_DAYS = 7;
const MAX_PAUSE_DAYS = 90;

function parseResumeDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid body'); }

  const resumeDate = parseResumeDate(parsed.resumeAt);
  if (!resumeDate) return fail(400, 'Choose a valid resume date');

  const now = Date.now();
  const minResume = now + MIN_PAUSE_DAYS * 24 * 60 * 60 * 1000;
  const maxResume = now + MAX_PAUSE_DAYS * 24 * 60 * 60 * 1000;
  if (resumeDate.getTime() < minResume || resumeDate.getTime() > maxResume) {
    return fail(400, 'Vacation pause must be between 7 and 90 days');
  }

  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 200)
    : 'Vacation pause';

  const subRes = await supaRequest<SubscriptionRow[]>(
    'GET',
    'subscriptions?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=user_id,plan,status,stripe_subscription_id,paypal_subscription_id&limit=1',
    null,
    serviceKey
  );
  const sub = Array.isArray(subRes.body) ? subRes.body[0] : undefined;
  if (!sub || sub.plan !== 'pro') return fail(404, 'No Pro subscription found');
  const hasBillingProvider = Boolean(sub.stripe_subscription_id || sub.paypal_subscription_id);
  const status = sub.status || '';
  const dbManagedPauseable =
    !hasBillingProvider && !['cancelled', 'expired', 'past_due', 'paused'].includes(status);
  if (status !== 'active' && !dbManagedPauseable) {
    // Block trialing too: pausing a Stripe trial via pause_collection has
    // surprising billing-period semantics, and the 7-day trial is short enough
    // that vacation-pause adds no value here.
    return fail(400, status === 'trialing'
      ? 'Pause is available after your trial ends'
      : 'Only active subscriptions can be paused');
  }

  try {
    if (sub.stripe_subscription_id) {
      requireEnv('STRIPE_SECRET_KEY');
      const params = new URLSearchParams();
      params.append('pause_collection[behavior]', 'void');
      params.append('pause_collection[resumes_at]', String(Math.floor(resumeDate.getTime() / 1000)));
      const result = await stripePost<BillingError>(
        '/v1/subscriptions/' + encodeURIComponent(sub.stripe_subscription_id),
        params
      );
      if (result.status < 200 || result.status >= 300) {
        return fail(result.status, result.body.error?.message || 'Stripe pause failed');
      }
    } else if (sub.paypal_subscription_id) {
      const paypalToken = await paypalOauthToken();
      const result = await paypalRequest<BillingError>(
        'POST',
        '/v1/billing/subscriptions/' + encodeURIComponent(sub.paypal_subscription_id) + '/suspend',
        paypalToken,
        { reason }
      );
      if (result.status < 200 || result.status >= 300) {
        return fail(result.status, result.body?.message || 'PayPal pause failed');
      }
    }

    const nowIso = new Date().toISOString();
    // PayPal has no scheduled auto-resume — /suspend pauses indefinitely until
    // a manual /activate call. Stripe's pause_collection.resumes_at unpauses
    // automatically and fires customer.subscription.updated, which our webhook
    // catches. So only persist a scheduled resume date when the row is backed
    // by Stripe (or has no provider — db-managed Pro keeps the field as a hint
    // but our scheduler still needs to be the one to honor it).
    const autoResumes = Boolean(sub.stripe_subscription_id);
    const resumeIso = resumeDate.toISOString();
    const writeRes = await supaRequest(
      'PATCH',
      'subscriptions?user_id=eq.' + encodeURIComponent(user.id),
      {
        status: 'paused',
        expires_at: nowIso,
        pause_started_at: nowIso,
        pause_resumes_at: autoResumes ? resumeIso : null,
        pause_reason: reason,
        updated_at: nowIso
      },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
    if (writeRes.status < 200 || writeRes.status >= 300) return fail(500, 'Could not save pause');
    return jsonResponse(200, {
      ok: true,
      status: 'paused',
      pause_resumes_at: autoResumes ? resumeIso : null,
      auto_resumes: autoResumes
    });
  } catch {
    return fail(500, 'Could not pause subscription');
  }
};

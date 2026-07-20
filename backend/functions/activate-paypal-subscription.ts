import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { logSecurityEvent } from '../lib/logger';
import { requireEnv, optionalEnv } from '../lib/env';
import {
  normalizeTrialDeviceId,
  hashTrialDeviceId,
  recordDeviceTrial
} from '../lib/trial-device';
import { recordSubEvent } from '../lib/subscription-events';
import { recordAffiliateTrial } from '../lib/affiliate';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const PAYPAL_API_BASE = optionalEnv('PAYPAL_API_BASE', 'https://api-m.paypal.com');
const PAYPAL_PLAN_ID = optionalEnv('PAYPAL_PLAN_ID', '');

interface PaypalTokenResponse { access_token?: string }
interface PaypalSubscription {
  id?: string;
  status?: string;
  plan_id?: string;
  custom_id?: string;
}

async function _parseJsonOrText<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

async function paypalRequest<T>(
  method: string, urlString: string, headers: Record<string, string>, body?: string | object
): Promise<{ status: number; body: T | null }> {
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  const res = await fetch(urlString, { method, headers, body: bodyStr });
  return { status: res.status, body: await _parseJsonOrText<T>(res) };
}

async function getPaypalToken(): Promise<string> {
  const clientId = requireEnv('PAYPAL_CLIENT_ID');
  const secret = requireEnv('PAYPAL_CLIENT_SECRET');
  const res = await paypalRequest<PaypalTokenResponse>(
    'POST',
    PAYPAL_API_BASE + '/v1/oauth2/token',
    {
      Authorization: 'Basic ' + btoa(clientId + ':' + secret),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    'grant_type=client_credentials'
  );
  if (res.status < 200 || res.status >= 300 || !res.body || !res.body.access_token) {
    throw new Error('Could not verify PayPal credentials');
  }
  return res.body.access_token;
}

async function getPaypalSubscription(subscriptionId: string, accessToken: string): Promise<PaypalSubscription> {
  const res = await paypalRequest<PaypalSubscription>(
    'GET',
    PAYPAL_API_BASE + '/v1/billing/subscriptions/' + encodeURIComponent(subscriptionId),
    { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
  );
  if (res.status < 200 || res.status >= 300 || !res.body || res.body.id !== subscriptionId) {
    throw new Error('PayPal subscription could not be verified');
  }
  return res.body;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid body');
  } catch { return fail(400, 'Invalid body'); }

  const subscriptionId = (body.subscriptionID || body.subscriptionId) as unknown;
  if (!subscriptionId || typeof subscriptionId !== 'string') return fail(400, 'Missing PayPal subscription ID');

  // Widerruf-Verzicht consent must be captured server-side, same as the Stripe
  // path. § 312j Abs. 3 / § 356 Abs. 5 BGB require explicit consent before
  // performance begins; without it we have no evidence for chargebacks.
  if (body.consentWiderrufVerzicht !== true) {
    return fail(400, 'Bitte bestaetige die Widerrufs-Information, bevor du fortfaehrst.');
  }
  const consentTimestamp =
    typeof body.consentTimestamp === 'string' && body.consentTimestamp.trim()
      ? body.consentTimestamp.trim().slice(0, 64)
      : new Date().toISOString();

  const trialDeviceId = normalizeTrialDeviceId(body.trialDeviceId);
  const trialDeviceHash = trialDeviceId ? hashTrialDeviceId(trialDeviceId) : '';

  try {
    const user = await verifySupabaseToken(token);
    if (!user) return fail(401, 'Unauthorized');

    const paypalToken = await getPaypalToken();
    const subscription = await getPaypalSubscription(subscriptionId, paypalToken);
    const status = String(subscription.status || '').toUpperCase();

    if (PAYPAL_PLAN_ID && subscription.plan_id && subscription.plan_id !== PAYPAL_PLAN_ID) {
      await logSecurityEvent(serviceKey, user.id, 'paypal_subscription_plan_mismatch', {
        subscription_id: subscriptionId, plan_id: subscription.plan_id
      });
      return fail(403, 'Subscription plan mismatch');
    }

    // Ownership check: the frontend stamps custom_id = user.id on createSubscription.
    // Require it server-side — without this anyone with a valid subscription ID on
    // the accepted plan could attach it to their account.
    if (!subscription.custom_id || subscription.custom_id !== user.id) {
      await logSecurityEvent(serviceKey, user.id, 'paypal_subscription_user_mismatch', {
        subscription_id: subscriptionId,
        custom_id: subscription.custom_id || null
      });
      return fail(403, 'Subscription does not belong to this user');
    }

    // Only grant Pro for a truly ACTIVE subscription. APPROVAL_PENDING means the
    // user has not yet completed the PayPal flow and no payment has settled —
    // granting access there is a free-Pro vulnerability.
    if (status !== 'ACTIVE') {
      await logSecurityEvent(serviceKey, user.id, 'paypal_subscription_not_active', {
        subscription_id: subscriptionId, paypal_status: status
      });
      return fail(400, 'Subscription is not active');
    }

    const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    const writeRes = await supaRequest('POST', 'subscriptions?on_conflict=user_id',
      {
        id: user.id, user_id: user.id, plan: 'pro', status: 'active',
        paypal_subscription_id: subscriptionId,
        had_trial: true,
        expires_at: expiresAt, updated_at: new Date().toISOString()
      },
      serviceKey, { Prefer: 'resolution=merge-duplicates,return=minimal' });

    if (writeRes.status < 200 || writeRes.status >= 300) throw new Error('Could not activate subscription');

    if (trialDeviceHash) {
      await recordDeviceTrial(serviceKey, trialDeviceHash, user.id, subscriptionId, 'paypal');
    }

    await recordSubEvent(serviceKey, {
      user_id: user.id,
      provider: 'paypal',
      event_type: 'trial_started',
      subscription_id: subscriptionId,
      period_end: expiresAt
    });
    await recordAffiliateTrial(serviceKey, user.id);

    const sourceIp =
      (event.headers && (event.headers['x-nf-client-connection-ip']
        || event.headers['x-forwarded-for']
        || event.headers['client-ip']))
      || '';
    await logSecurityEvent(serviceKey, user.id, 'paypal_subscription_activated', {
      subscription_id: subscriptionId,
      paypal_status: status,
      consent_widerruf_verzicht: true,
      consent_widerruf_verzicht_at: consentTimestamp,
      consent_widerruf_verzicht_ip: String(sourceIp).slice(0, 64) || null
    });

    return jsonResponse(200, { ok: true, plan: 'pro', status: 'active' });
  } catch (e: unknown) {
    // Surface the underlying cause to Netlify function logs so we can
    // actually debug failures (DB writes, PayPal API, etc.).
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[activate-paypal-subscription] failed:', msg, e);
    return fail(500, 'Could not activate subscription');
  }
};

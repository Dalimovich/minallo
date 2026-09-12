import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost } from '../lib/stripe';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { requireEnv } from '../lib/env';
import {
  normalizeTrialDeviceId,
  hashTrialDeviceId,
  hasUsedDeviceTrial
} from '../lib/trial-device';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeError { error?: { message?: string } }
interface StripeSession { url?: string }
type StripeResponse = StripeSession & StripeError;
interface SubscriptionRow { had_trial?: boolean | null }

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const priceId = requireEnv('STRIPE_PRICE_ID');
  requireEnv('STRIPE_SECRET_KEY');
  const allowedOrigin = requireEnv('ALLOWED_ORIGIN');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid body');

  let noTrial = false;
  if (Object.prototype.hasOwnProperty.call(body, 'noTrial')) {
    if (typeof body.noTrial !== 'boolean') return fail(400, 'noTrial must be a boolean');
    noTrial = body.noTrial;
  }

  const trialDeviceId = normalizeTrialDeviceId(body.trialDeviceId);
  const trialDeviceHash = trialDeviceId ? hashTrialDeviceId(trialDeviceId) : '';
  const deviceAlreadyUsedTrial = trialDeviceHash
    ? await hasUsedDeviceTrial(serviceKey, trialDeviceHash)
    : false;
  const existingSubRes = await supaRequest<SubscriptionRow[]>(
    'GET',
    'subscriptions?user_id=eq.' + encodeURIComponent(user.id) + '&select=had_trial&limit=1',
    null,
    serviceKey
  );
  const existingSub = Array.isArray(existingSubRes.body) ? existingSubRes.body[0] : undefined;
  if (deviceAlreadyUsedTrial || existingSub?.had_trial) noTrial = true;

  // German digital-services consent: § 312j Abs. 3 BGB requires explicit consent
  // to begin performance before the 14-day withdrawal period ends. Without it
  // the consumer keeps the full Widerruf right after using the service, which
  // is a refund liability we don't want to carry. Refuse the checkout if the
  // client didn't capture the consent.
  const consent = body.consentWiderrufVerzicht;
  if (consent !== true) {
    return fail(400, 'Bitte bestaetige die Widerrufs-Information, bevor du fortfaehrst.');
  }
  const consentTimestamp =
    typeof body.consentTimestamp === 'string' && body.consentTimestamp.trim()
      ? body.consentTimestamp.trim().slice(0, 64)
      : new Date().toISOString();

  try {
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('payment_method_types[]', 'card');
    params.append('payment_method_types[]', 'klarna');
    params.append('payment_method_types[]', 'paypal');
    if (!noTrial) params.append('subscription_data[trial_period_days]', '7');
    params.append('metadata[no_trial]', noTrial ? 'true' : 'false');
    if (trialDeviceHash) params.append('metadata[trial_device_hash]', trialDeviceHash);
    params.append('metadata[consent_widerruf_verzicht]', 'true');
    params.append('metadata[consent_widerruf_verzicht_at]', consentTimestamp);
    // Source IP is captured by Netlify on the request; persist it so we can
    // evidence the consent if a chargeback claim asserts the user never agreed.
    const sourceIp =
      (event.headers && (event.headers['x-nf-client-connection-ip']
        || event.headers['x-forwarded-for']
        || event.headers['client-ip']))
      || '';
    if (sourceIp) params.append('metadata[consent_widerruf_verzicht_ip]', String(sourceIp).slice(0, 64));
    params.append('success_url', allowedOrigin + '?payment=success&session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', allowedOrigin + '?payment=cancelled');
    params.append('metadata[user_id]', user.id);
    if (user.email) params.append('customer_email', user.email);

    const result = await stripePost<StripeResponse>('/v1/checkout/sessions', params);
    if (result.status !== 200) return fail(result.status, result.body.error?.message || 'Stripe error');
    return jsonResponse(200, { url: result.body.url });
  } catch {
    return fail(500, 'Could not create checkout session');
  }
};

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost } from '../lib/stripe';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeError { error?: { message?: string } }
interface StripeSession { url?: string }
type StripeResponse = StripeSession & StripeError;

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const priceId = requireEnv('STRIPE_PRICE_ID');
  requireEnv('STRIPE_SECRET_KEY');
  const allowedOrigin = requireEnv('ALLOWED_ORIGIN');

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

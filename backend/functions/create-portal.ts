import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost } from '../lib/stripe';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeResponse { url?: string; error?: { message?: string } }
interface SubscriptionRow { stripe_customer_id?: string | null }

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  requireEnv('STRIPE_SECRET_KEY');
  const allowedOrigin = requireEnv('ALLOWED_ORIGIN');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const subRes = await supaRequest<SubscriptionRow[]>(
    'GET',
    'subscriptions?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=stripe_customer_id&stripe_customer_id=not.is.null&limit=1',
    null, serviceKey, { Accept: 'application/json' }
  );
  const subscription = Array.isArray(subRes.body) ? subRes.body[0] : null;
  const customerId = subscription && subscription.stripe_customer_id;
  if (!customerId) return fail(400, 'No Stripe account found for this user');

  try {
    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', allowedOrigin + '?section=subscription');
    const result = await stripePost<StripeResponse>('/v1/billing_portal/sessions', params);
    if (result.status !== 200) return fail(result.status, result.body.error?.message || 'Stripe error');
    return jsonResponse(200, { url: result.body.url });
  } catch {
    return fail(500, 'Could not create portal session');
  }
};

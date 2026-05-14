import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { stripePost } from '../lib/stripe';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeResponse { url?: string; error?: { message?: string } }
interface ProfileRow { stripe_customer_id?: string }

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
  const profileRes = await supaRequest<ProfileRow[]>(
    'GET',
    'profiles?id=eq.' + encodeURIComponent(user.id) + '&select=stripe_customer_id',
    null, serviceKey, { Accept: 'application/json' }
  );
  const profile = Array.isArray(profileRes.body) ? profileRes.body[0] : null;
  const customerId = profile && profile.stripe_customer_id;
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

import crypto from 'crypto';
import { requireEnv } from '../lib/env';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeEvent<T = unknown> {
  type: string;
  data: { object: T };
}

interface CheckoutSession {
  metadata?: { user_id?: string; no_trial?: string };
  subscription?: string | null;
  customer?: string | null;
}

interface SubscriptionObject {
  id?: string;
  status?: string;
  customer?: string;
  current_period_end?: number;
}

interface InvoiceObject {
  customer?: string;
}

function verifyStripeSignature(payload: string, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
    const eq = p.indexOf('=');
    if (eq !== -1) acc[p.slice(0, eq)] = p.slice(eq + 1);
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signed = parts.t + '.' + payload;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(parts.v1, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const sig = event.headers['stripe-signature'];
  try {
    if (!verifyStripeSignature(event.body || '', sig, webhookSecret)) {
      return { statusCode: 400, body: 'Invalid signature' };
    }
  } catch {
    return { statusCode: 400, body: 'Signature error' };
  }

  let evt: StripeEvent;
  try { evt = JSON.parse(event.body || '') as StripeEvent; }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const prefer = { Prefer: 'resolution=merge-duplicates,return=minimal' };

  if (evt.type === 'checkout.session.completed') {
    const session = evt.data.object as CheckoutSession;
    const userId = session.metadata?.user_id;
    if (userId) {
      const noTrial = session.metadata?.no_trial === 'true';
      const expiresAt = new Date(
        Date.now() + (noTrial ? 31 : 8) * 24 * 60 * 60 * 1000
      ).toISOString();
      await supaRequest('POST', 'subscriptions?on_conflict=user_id',
        {
          user_id: userId, plan: 'pro', status: noTrial ? 'active' : 'trialing',
          stripe_subscription_id: session.subscription || null,
          stripe_customer_id: session.customer || null,
          expires_at: expiresAt,
          had_trial: !noTrial,
          updated_at: new Date().toISOString()
        },
        serviceKey, prefer);
    }
  }

  if (evt.type === 'customer.subscription.deleted') {
    const cusId = (evt.data.object as SubscriptionObject).customer;
    if (cusId) {
      await supaRequest('PATCH',
        'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(cusId),
        { status: 'cancelled', updated_at: new Date().toISOString() },
        serviceKey, prefer);
    }
  }

  if (evt.type === 'customer.subscription.updated') {
    const sub = evt.data.object as SubscriptionObject;
    const cusId = sub.customer;
    if (cusId) {
      const isActive = sub.status === 'active' || sub.status === 'trialing';
      const patch: Record<string, unknown> = {
        status: isActive ? 'active' : sub.status,
        stripe_subscription_id: sub.id || null,
        updated_at: new Date().toISOString()
      };
      if (sub.current_period_end) patch.expires_at = new Date(sub.current_period_end * 1000).toISOString();
      await supaRequest('PATCH',
        'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(cusId),
        patch, serviceKey, prefer);
    }
  }

  if (evt.type === 'invoice.payment_failed') {
    const cusId = (evt.data.object as InvoiceObject).customer;
    if (cusId) {
      await supaRequest('PATCH',
        'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(cusId),
        { status: 'past_due', updated_at: new Date().toISOString() },
        serviceKey, prefer);
    }
  }

  return { statusCode: 200, body: 'ok' };
};

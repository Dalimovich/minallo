// Stripe webhook receiver. Verifies the signed payload against the raw body,
// rejects events outside a 5-minute window (replay protection), records the
// event id for idempotency, and returns 5xx on database write failures so
// Stripe will retry rather than dropping state on the floor.

import crypto from 'crypto';
import { requireEnv } from '../lib/env';
import { supaRequest } from '../lib/supabase-admin';
import { stripeGet } from '../lib/stripe';
import { recordDeviceTrial } from '../lib/trial-device';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface StripeEvent<T = unknown> {
  id?: string;
  type: string;
  data: { object: T };
}

interface CheckoutSession {
  metadata?: { user_id?: string; no_trial?: string; trial_device_hash?: string };
  subscription?: string | null;
  customer?: string | null;
}

interface SubscriptionObject {
  id?: string;
  status?: string;
  customer?: string;
  current_period_end?: number;
  pause_collection?: unknown;
  cancel_at_period_end?: boolean;
}

interface InvoiceObject {
  customer?: string;
}

const SIGNATURE_TOLERANCE_SECONDS = 300; // matches stripe-node default

function verifyStripeSignature(
  rawPayload: string,
  sigHeader: string | undefined,
  secret: string
): { ok: true } | { ok: false; reason: string } {
  if (!sigHeader || typeof sigHeader !== 'string') return { ok: false, reason: 'missing signature header' };
  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
    const eq = p.indexOf('=');
    if (eq !== -1) acc[p.slice(0, eq)] = p.slice(eq + 1);
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return { ok: false, reason: 'malformed signature header' };

  const timestamp = parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'invalid timestamp' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const signed = parts.t + '.' + rawPayload;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(parts.v1, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return { ok: false, reason: 'signature length mismatch' };
  if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

function rawBody(event: NetlifyEvent): string {
  // Stripe verifies against the bytes-exact body. Netlify will base64-encode the
  // body if it considers the Content-Type binary; decode to the original string
  // before hashing so the signature still matches.
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body || '';
}

function isoOrNull(unixSeconds: number | undefined): string | null {
  return typeof unixSeconds === 'number' && Number.isFinite(unixSeconds)
    ? new Date(unixSeconds * 1000).toISOString()
    : null;
}

/** Record an event row in `stripe_webhook_events` BEFORE processing. Returns
 *  true if the row was newly inserted (we should process), false if it already
 *  existed (duplicate — short-circuit). */
type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'duplicate' }
  | { kind: 'error'; status: number };

async function claimEvent(
  eventId: string,
  eventType: string,
  serviceKey: string
): Promise<ClaimOutcome> {
  // Postgrest returns 409 if the row already exists (real duplicate, thanks to
  // the PK on event_id). Anything else (5xx, network failure surfaced as 0,
  // RLS misconfig) is a transient/operational failure: do NOT swallow it as a
  // duplicate, otherwise Stripe stops retrying and we permanently lose the
  // event.
  const res = await supaRequest(
    'POST',
    'stripe_webhook_events',
    { event_id: eventId, event_type: eventType, status: 'received' },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
  if (res.status === 201) return { kind: 'claimed' };
  if (res.status === 409) return { kind: 'duplicate' };
  return { kind: 'error', status: res.status };
}

async function markEvent(
  eventId: string,
  status: 'processed' | 'failed',
  serviceKey: string,
  errorMsg?: string
): Promise<void> {
  await supaRequest(
    'PATCH',
    'stripe_webhook_events?event_id=eq.' + encodeURIComponent(eventId),
    {
      status,
      processed_at: new Date().toISOString(),
      error: errorMsg ? errorMsg.slice(0, 500) : null
    },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
}

/** Wraps supaRequest and throws if the response is not 2xx so the outer
 *  try/catch can mark the event as failed and return 5xx to Stripe. */
async function supaWriteOrThrow(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  serviceKey: string,
  prefer: Record<string, string>
): Promise<void> {
  const res = await supaRequest(method, path, body, serviceKey, prefer);
  if (res.status < 200 || res.status >= 300) {
    throw new Error('Supabase write failed: ' + method + ' ' + path + ' -> ' + res.status);
  }
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const webhookSecret = requireEnv('STRIPE_WEBHOOK_SECRET');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const body = rawBody(event);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const sigCheck = verifyStripeSignature(body, sig, webhookSecret);
  if (!sigCheck.ok) {
    return { statusCode: 400, body: 'Invalid signature: ' + sigCheck.reason };
  }

  let evt: StripeEvent;
  try { evt = JSON.parse(body) as StripeEvent; }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  if (!evt.id || typeof evt.id !== 'string') {
    return { statusCode: 400, body: 'Missing event id' };
  }

  // Idempotency: insert the event id. Only treat a real 409 conflict as a
  // duplicate; any other non-success is a transient failure and MUST return
  // 5xx so Stripe keeps retrying — otherwise the payment/subscription event
  // is lost forever.
  const claim = await claimEvent(evt.id, evt.type, serviceKey);
  if (claim.kind === 'duplicate') return { statusCode: 200, body: 'duplicate' };
  if (claim.kind === 'error') {
    return { statusCode: 503, body: 'ledger unavailable: ' + claim.status };
  }

  const prefer = { Prefer: 'resolution=merge-duplicates,return=minimal' };

  try {
    if (evt.type === 'checkout.session.completed') {
      const session = evt.data.object as CheckoutSession;
      const userId = session.metadata?.user_id;
      if (userId) {
        const noTrial = session.metadata?.no_trial === 'true';

        // Prefer the real current_period_end from Stripe so we don't drift
        // from the billing cycle. Fall back to a reasonable default if the
        // subscription read fails.
        let expiresAt: string | null = null;
        if (session.subscription) {
          try {
            const subRes = await stripeGet<SubscriptionObject>(
              '/v1/subscriptions/' + encodeURIComponent(String(session.subscription))
            );
            if (subRes.status >= 200 && subRes.status < 300) {
              expiresAt = isoOrNull(subRes.body.current_period_end);
            }
          } catch { /* fall back to default below */ }
        }
        if (!expiresAt) {
          expiresAt = new Date(
            Date.now() + (noTrial ? 31 : 8) * 24 * 60 * 60 * 1000
          ).toISOString();
        }

        await supaWriteOrThrow('POST', 'subscriptions?on_conflict=user_id',
          {
            user_id: userId, plan: 'pro', status: noTrial ? 'active' : 'trialing',
            stripe_subscription_id: session.subscription || null,
            stripe_customer_id: session.customer || null,
            expires_at: expiresAt,
            had_trial: !noTrial,
            updated_at: new Date().toISOString()
          },
          serviceKey, prefer);

        if (!noTrial && session.metadata?.trial_device_hash) {
          await recordDeviceTrial(
            serviceKey,
            session.metadata.trial_device_hash,
            userId,
            session.subscription || null,
            'stripe'
          );
        }
      }
    }

    if (evt.type === 'customer.subscription.deleted') {
      const sub = evt.data.object as SubscriptionObject;
      const cusId = sub.customer;
      if (cusId) {
        // Stamp expires_at to now() so app code keying off it correctly
        // treats the user as expired even before the next sync.
        await supaWriteOrThrow('PATCH',
          'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(cusId),
          {
            status: 'cancelled',
            expires_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          serviceKey, prefer);
      }
    }

    if (evt.type === 'customer.subscription.updated') {
      const sub = evt.data.object as SubscriptionObject;
      const cusId = sub.customer;
      if (cusId) {
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        const isPaused = Boolean(sub.pause_collection);
        const patch: Record<string, unknown> = {
          status: isPaused ? 'paused' : (isActive ? 'active' : sub.status),
          stripe_subscription_id: sub.id || null,
          // Mirror Stripe's flag so UI stays in sync if the user toggles
          // cancellation on/off from the customer portal.
          cancel_at_period_end: Boolean(sub.cancel_at_period_end),
          updated_at: new Date().toISOString()
        };
        const periodEnd = isoOrNull(sub.current_period_end);
        if (isPaused) {
          patch.expires_at = new Date().toISOString();
        } else if (periodEnd) {
          patch.expires_at = periodEnd;
          patch.pause_started_at = null;
          patch.pause_resumes_at = null;
          patch.pause_reason = null;
        }
        await supaWriteOrThrow('PATCH',
          'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(cusId),
          patch, serviceKey, prefer);
      }
    }

    if (evt.type === 'invoice.payment_failed') {
      const cusId = (evt.data.object as InvoiceObject).customer;
      if (cusId) {
        // Past_due users should lose access immediately. The grace period (if
        // any) is configured in Stripe — we mirror their decision by stamping
        // expires_at to now(). When they pay, customer.subscription.updated
        // restores expires_at to the new period end.
        await supaWriteOrThrow('PATCH',
          'subscriptions?stripe_customer_id=eq.' + encodeURIComponent(cusId),
          {
            status: 'past_due',
            expires_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          serviceKey, prefer);
      }
    }

    await markEvent(evt.id, 'processed', serviceKey);
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    await markEvent(evt.id, 'failed', serviceKey, msg).catch(() => undefined);
    // 5xx tells Stripe to retry. The event row stays in 'failed' state and the
    // unique-key check above will admit the retry (we update it back to
    // 'received' on retry... actually no: the duplicate short-circuit returns
    // 200. To allow retry of failed events we need to delete the row instead.
    await supaRequest(
      'DELETE',
      'stripe_webhook_events?event_id=eq.' + encodeURIComponent(evt.id),
      null,
      serviceKey,
      { Prefer: 'return=minimal' }
    ).catch(() => undefined);
    return { statusCode: 500, body: 'processing failed' };
  }
};

// PayPal webhook receiver.
//
// PayPal cannot be verified by HMAC over the raw body (unlike Stripe). Instead
// the request is verified by POSTing the headers + body back to PayPal's
// /v1/notifications/verify-webhook-signature endpoint with the configured
// webhook ID. That returns { verification_status: 'SUCCESS' | 'FAILURE' }.
//
// Required env:
//   PAYPAL_CLIENT_ID         — OAuth client id
//   PAYPAL_CLIENT_SECRET     — OAuth client secret
//   PAYPAL_WEBHOOK_ID        — id of the webhook registered in PayPal dashboard
//   PAYPAL_API_BASE          — optional, defaults to live
//   SUPABASE_SERVICE_ROLE_KEY
//
// Events handled:
//   - BILLING.SUBSCRIPTION.CANCELLED  → status=cancelled, expires_at=now()
//   - BILLING.SUBSCRIPTION.SUSPENDED  → status=paused,    expires_at=now()
//   - BILLING.SUBSCRIPTION.EXPIRED    → status=cancelled, expires_at=now()
//   - BILLING.SUBSCRIPTION.ACTIVATED  → status=active,    extend expires_at
//   - PAYMENT.SALE.COMPLETED          → status=active,    extend expires_at
//   - BILLING.SUBSCRIPTION.PAYMENT.FAILED → status=past_due, expires_at=now();
//     after the 3rd consecutive failure the subscription is cancelled at
//     PayPal so the user is never charged again.
// Any other event type is acknowledged but not acted on.

import { requireEnv, optionalEnv } from '../lib/env';
import { supaRequest } from '../lib/supabase-admin';
import { recordSubEvent, lookupByPaypalSub } from '../lib/subscription-events';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const PAYPAL_API_BASE = optionalEnv('PAYPAL_API_BASE', 'https://api-m.paypal.com');

interface PaypalEvent {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;                // subscription id for BILLING.* events
    billing_agreement_id?: string;  // subscription id for PAYMENT.SALE.* events
    custom_id?: string;         // user id (we set this at subscription create time)
    status?: string;
    billing_info?: {
      failed_payments_count?: number;
    };
  };
}

// Hard cap on consecutive failed charges. PayPal keeps retrying per the plan's
// payment_failure_threshold; after the third failure we cancel the
// subscription ourselves so a user with no funds is never charged again.
const MAX_PAYMENT_FAILURES = 3;

interface VerifyResponse {
  verification_status?: string;
}

interface OauthTokenResponse {
  access_token?: string;
}

async function _parseJsonOrText<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

async function paypalRequest<T>(
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string | object
): Promise<{ status: number; body: T | null }> {
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  const res = await fetch(urlString, { method, headers, body: bodyStr });
  return { status: res.status, body: await _parseJsonOrText<T>(res) };
}

async function paypalOauthToken(): Promise<string> {
  const clientId = requireEnv('PAYPAL_CLIENT_ID');
  const secret = requireEnv('PAYPAL_CLIENT_SECRET');
  const res = await paypalRequest<OauthTokenResponse>(
    'POST',
    PAYPAL_API_BASE + '/v1/oauth2/token',
    {
      Authorization: 'Basic ' + btoa(clientId + ':' + secret),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    'grant_type=client_credentials'
  );
  if (res.status < 200 || res.status >= 300 || !res.body || !res.body.access_token) {
    throw new Error('paypal oauth failed');
  }
  return res.body.access_token;
}

/** Verify the webhook by calling PayPal's verification endpoint. Returns true
 *  only on `verification_status: SUCCESS`. Any other outcome is a rejection. */
async function verifyPaypalSignature(
  event: NetlifyEvent,
  rawBodyJson: unknown,
  accessToken: string
): Promise<boolean> {
  const webhookId = requireEnv('PAYPAL_WEBHOOK_ID');
  const h = event.headers || {};
  const get = (k: string): string => h[k] || h[k.toLowerCase()] || h[k.toUpperCase()] || '';
  const verifyBody = {
    auth_algo: get('paypal-auth-algo'),
    cert_url: get('paypal-cert-url'),
    transmission_id: get('paypal-transmission-id'),
    transmission_sig: get('paypal-transmission-sig'),
    transmission_time: get('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: rawBodyJson
  };
  if (!verifyBody.transmission_id || !verifyBody.transmission_sig) return false;
  const res = await paypalRequest<VerifyResponse>(
    'POST',
    PAYPAL_API_BASE + '/v1/notifications/verify-webhook-signature',
    {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    verifyBody
  );
  return Boolean(res.body && res.body.verification_status === 'SUCCESS');
}

function rawBody(event: NetlifyEvent): string {
  if (event.isBase64Encoded && event.body) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body || '';
}

type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'duplicate' }
  | { kind: 'error'; status: number };

async function claimEvent(
  eventId: string,
  eventType: string,
  serviceKey: string
): Promise<ClaimOutcome> {
  // 409 = real duplicate (PK collision). Anything else is transient and must
  // bubble up as 5xx so PayPal keeps retrying — otherwise the event is lost.
  const res = await supaRequest(
    'POST',
    'paypal_webhook_events',
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
    'paypal_webhook_events?event_id=eq.' + encodeURIComponent(eventId),
    {
      status,
      processed_at: new Date().toISOString(),
      error: errorMsg ? errorMsg.slice(0, 500) : null
    },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
}

async function supaWriteOrThrow(
  method: 'PATCH' | 'POST',
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

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const body = rawBody(event);

  let parsed: PaypalEvent;
  try { parsed = JSON.parse(body) as PaypalEvent; }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  if (!parsed.id || !parsed.event_type) {
    return { statusCode: 400, body: 'Missing event id or type' };
  }

  // Verify signature by round-tripping to PayPal. If this fails we bail before
  // touching anything in Supabase — the request is either spoofed or our
  // webhook config drifted.
  let token: string;
  try { token = await paypalOauthToken(); }
  catch { return { statusCode: 502, body: 'paypal auth unavailable' }; }

  const sigOk = await verifyPaypalSignature(event, parsed, token);
  if (!sigOk) return { statusCode: 400, body: 'Invalid signature' };

  // Idempotency — only short-circuit on a real PK collision; transient ledger
  // failures must return 5xx so PayPal retries.
  const claim = await claimEvent(parsed.id, parsed.event_type, serviceKey);
  if (claim.kind === 'duplicate') return { statusCode: 200, body: 'duplicate' };
  if (claim.kind === 'error') {
    return { statusCode: 503, body: 'ledger unavailable: ' + claim.status };
  }

  const prefer = { Prefer: 'resolution=merge-duplicates,return=minimal' };
  const subId =
    parsed.resource?.id || parsed.resource?.billing_agreement_id || '';

  try {
    if (!subId) {
      // Event we can't tie to a subscription — mark processed and move on.
      await markEvent(parsed.id, 'processed', serviceKey);
      return { statusCode: 200, body: 'ok' };
    }

    // user_id for analytics: custom_id is set on BILLING.* events; fall back to
    // a lookup by subscription id (e.g. PAYMENT.SALE.COMPLETED).
    const analyticsUid = parsed.resource?.custom_id || (await lookupByPaypalSub(serviceKey, subId));

    if (
      parsed.event_type === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      parsed.event_type === 'BILLING.SUBSCRIPTION.EXPIRED'
    ) {
      await supaWriteOrThrow('PATCH',
        'subscriptions?paypal_subscription_id=eq.' + encodeURIComponent(subId),
        {
          status: 'cancelled',
          expires_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        serviceKey, prefer);
      await recordSubEvent(serviceKey, {
        user_id: analyticsUid, provider: 'paypal',
        event_type: parsed.event_type === 'BILLING.SUBSCRIPTION.EXPIRED' ? 'expired' : 'cancelled',
        subscription_id: subId
      });
    } else if (parsed.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      // A charge attempt bounced (no funds, expired card, …). Revoke access
      // now; a later successful payment re-extends via PAYMENT.SALE.COMPLETED.
      await supaWriteOrThrow('PATCH',
        'subscriptions?paypal_subscription_id=eq.' + encodeURIComponent(subId),
        {
          status: 'past_due',
          expires_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        serviceKey, prefer);

      // Third consecutive failure → cancel at PayPal so it never charges this
      // account again. 422 = not in a cancellable state (already cancelled or
      // suspended), which is the outcome we want anyway. Other failures throw
      // so PayPal redelivers the event and the cancel is retried.
      const failures = Number(parsed.resource?.billing_info?.failed_payments_count) || 0;
      if (failures >= MAX_PAYMENT_FAILURES) {
        const cancelRes = await paypalRequest(
          'POST',
          PAYPAL_API_BASE + '/v1/billing/subscriptions/' + encodeURIComponent(subId) + '/cancel',
          { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          { reason: 'Payment failed ' + failures + ' times' }
        );
        if ((cancelRes.status < 200 || cancelRes.status >= 300) && cancelRes.status !== 422) {
          throw new Error('cancel after ' + failures + ' failed payments -> ' + cancelRes.status);
        }
        await supaWriteOrThrow('PATCH',
          'subscriptions?paypal_subscription_id=eq.' + encodeURIComponent(subId),
          {
            status: 'cancelled',
            expires_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          serviceKey, prefer);
        await recordSubEvent(serviceKey, {
          user_id: analyticsUid, provider: 'paypal', event_type: 'cancelled',
          subscription_id: subId
        });
      }
    } else if (parsed.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
      await supaWriteOrThrow('PATCH',
        'subscriptions?paypal_subscription_id=eq.' + encodeURIComponent(subId),
        {
          status: 'paused',
          expires_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        serviceKey, prefer);
    } else if (
      parsed.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' ||
      parsed.event_type === 'PAYMENT.SALE.COMPLETED'
    ) {
      // A successful renewal payment. Extend access by 31 days. Use the
      // existing user_id and plan; only update access fields.
      const expires = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
      await supaWriteOrThrow('PATCH',
        'subscriptions?paypal_subscription_id=eq.' + encodeURIComponent(subId),
        {
          status: 'active',
          expires_at: expires,
          pause_started_at: null,
          pause_resumes_at: null,
          pause_reason: null,
          updated_at: new Date().toISOString()
        },
        serviceKey, prefer);
      // ACTIVATED = first paid activation; SALE.COMPLETED = a recurring payment.
      await recordSubEvent(serviceKey, {
        user_id: analyticsUid, provider: 'paypal',
        event_type: parsed.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED' ? 'paid' : 'renewed',
        subscription_id: subId,
        period_end: expires
      });
    }

    await markEvent(parsed.id, 'processed', serviceKey);
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    await markEvent(parsed.id, 'failed', serviceKey, msg).catch(() => undefined);
    // Allow Stripe-style retry by removing the ledger row.
    await supaRequest(
      'DELETE',
      'paypal_webhook_events?event_id=eq.' + encodeURIComponent(parsed.id),
      null,
      serviceKey,
      { Prefer: 'return=minimal' }
    ).catch(() => undefined);
    return { statusCode: 500, body: 'processing failed' };
  }
};

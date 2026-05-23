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
// Any other event type is acknowledged but not acted on.

import { requireEnv, optionalEnv } from '../lib/env';
import { supaRequest } from '../lib/supabase-admin';
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
  };
}

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

async function claimEvent(
  eventId: string,
  eventType: string,
  serviceKey: string
): Promise<boolean> {
  const res = await supaRequest(
    'POST',
    'paypal_webhook_events',
    { event_id: eventId, event_type: eventType, status: 'received' },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
  return res.status === 201;
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

  // Idempotency
  const claimed = await claimEvent(parsed.id, parsed.event_type, serviceKey);
  if (!claimed) return { statusCode: 200, body: 'duplicate' };

  const prefer = { Prefer: 'resolution=merge-duplicates,return=minimal' };
  const subId =
    parsed.resource?.id || parsed.resource?.billing_agreement_id || '';

  try {
    if (!subId) {
      // Event we can't tie to a subscription — mark processed and move on.
      await markEvent(parsed.id, 'processed', serviceKey);
      return { statusCode: 200, body: 'ok' };
    }

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

// Tests for the four payment-flow branches called out in the security review:
//   1. Cancel-anyway result code → proceeds with cancellation (frontend logic)
//   2. Webhook ledger transient failures → 5xx so provider retries
//   3. PayPal activation gates: missing consent / missing ownership / wrong status
//   4. verify-payment surfaces a Supabase write failure as 5xx, not ok:true
//
// We don't run a real Supabase or Stripe. globalThis.fetch is stubbed per-test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

function setEnv() {
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  process.env.STRIPE_PRICE_ID = 'price_fake';
  process.env.ALLOWED_ORIGIN = 'https://example.com';
  process.env.PAYPAL_CLIENT_ID = 'pp_id';
  process.env.PAYPAL_CLIENT_SECRET = 'pp_secret';
  process.env.PAYPAL_API_BASE = 'https://api.sandbox.paypal.com';
  process.env.PAYPAL_WEBHOOK_ID = 'WH-FAKE';
}
setEnv();

const realFetch = globalThis.fetch;
function withFetch(handlers) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    for (const h of handlers) {
      if (h.match(u, init)) return h.respond(u, init);
    }
    throw new Error('unexpected fetch in test: ' + u);
  };
  return () => { globalThis.fetch = realFetch; };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function signStripe(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signed = timestamp + '.' + payload;
  const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

// -----------------------------------------------------------------------------
// (1) Cancel-anyway: pure decision logic mirroring subscription.js
// -----------------------------------------------------------------------------
// The bug was: handlers returned early on result === 'cancel'. Contract is:
//   'dismiss' → stop (user kept the subscription / clicked backdrop)
//   'cancel'  → proceed to cancellation
//   'accept'  → apply discount and stop

function shouldStopAfterRetentionOffer(result) {
  return result === 'dismiss';
}

test('cancel flow: dismiss stops the cancellation', () => {
  assert.equal(shouldStopAfterRetentionOffer('dismiss'), true);
});

test('cancel flow: "cancel anyway" proceeds with cancellation', () => {
  assert.equal(shouldStopAfterRetentionOffer('cancel'), false);
});

test('cancel flow: accept does not stop the next-handler block', () => {
  // 'accept' is handled by its own branch — the gate is only 'dismiss'.
  assert.equal(shouldStopAfterRetentionOffer('accept'), false);
});

// -----------------------------------------------------------------------------
// (2) Webhook ledger transient failure → 503
// -----------------------------------------------------------------------------
test('stripe-webhook: ledger 500 returns 5xx (not 200 duplicate)', async () => {
  const restore = withFetch([
    {
      match: u => u.includes('/stripe_webhook_events'),
      respond: () => jsonResponse(500, { message: 'Supabase boom' })
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/stripe-webhook.ts')];
    const { handler } = require('../../backend/functions/stripe-webhook.ts');

    const payload = JSON.stringify({
      id: 'evt_ledger_fail',
      type: 'payment_intent.created',
      data: { object: {} }
    });
    const sig = signStripe(payload, process.env.STRIPE_WEBHOOK_SECRET);
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload
    });
    assert.equal(res.statusCode, 503, 'must be retriable, not 200 duplicate');
    assert.match(String(res.body), /ledger/);
  } finally { restore(); }
});

test('stripe-webhook: ledger 409 returns 200 duplicate', async () => {
  const restore = withFetch([
    {
      match: u => u.includes('/stripe_webhook_events'),
      respond: () => jsonResponse(409, { message: 'duplicate key' })
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/stripe-webhook.ts')];
    const { handler } = require('../../backend/functions/stripe-webhook.ts');

    const payload = JSON.stringify({
      id: 'evt_real_duplicate',
      type: 'payment_intent.created',
      data: { object: {} }
    });
    const sig = signStripe(payload, process.env.STRIPE_WEBHOOK_SECRET);
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'stripe-signature': sig },
      body: payload
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body), /duplicate/);
  } finally { restore(); }
});

test('paypal-webhook: ledger 500 returns 5xx (not 200 duplicate)', async () => {
  const restore = withFetch([
    {
      match: u => u.includes('/v1/oauth2/token'),
      respond: () => jsonResponse(200, { access_token: 'pp_token' })
    },
    {
      match: u => u.includes('/verify-webhook-signature'),
      respond: () => jsonResponse(200, { verification_status: 'SUCCESS' })
    },
    {
      match: u => u.includes('/paypal_webhook_events'),
      respond: () => jsonResponse(503, { message: 'Supabase boom' })
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/paypal-webhook.ts')];
    const { handler } = require('../../backend/functions/paypal-webhook.ts');

    const res = await handler({
      httpMethod: 'POST',
      headers: {
        'paypal-transmission-id': 't',
        'paypal-transmission-time': '2026-05-25T00:00:00Z',
        'paypal-transmission-sig': 'sig',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-auth-algo': 'SHA256withRSA'
      },
      body: JSON.stringify({
        id: 'WH-LEDGER-FAIL',
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: 'I-SUB-1' }
      })
    });
    assert.equal(res.statusCode, 503);
  } finally { restore(); }
});

// -----------------------------------------------------------------------------
// (3) PayPal activation gates — consent + ownership + status
// -----------------------------------------------------------------------------
function makeAuthHeaders() {
  // verifySupabaseToken will hit Supabase Auth. We stub it via fetch below.
  return { authorization: 'Bearer fake-user-jwt' };
}

function stubAuth(userId) {
  return {
    match: u => u.includes('/auth/v1/user'),
    respond: () => jsonResponse(200, { id: userId, email: 'u@example.com' })
  };
}

test('activate-paypal: missing consent returns 400', async () => {
  const restore = withFetch([stubAuth('user-1')]);
  try {
    delete require.cache[require.resolve('../../backend/functions/activate-paypal-subscription.ts')];
    const { handler } = require('../../backend/functions/activate-paypal-subscription.ts');
    const res = await handler({
      httpMethod: 'POST',
      headers: makeAuthHeaders(),
      body: JSON.stringify({ subscriptionID: 'I-ABC' }) // no consent
    });
    assert.equal(res.statusCode, 400);
    assert.match(String(res.body), /Widerruf/);
  } finally { restore(); }
});

test('activate-paypal: APPROVAL_PENDING is rejected (no premature Pro)', async () => {
  const restore = withFetch([
    stubAuth('user-1'),
    {
      match: u => u.includes('/v1/oauth2/token'),
      respond: () => jsonResponse(200, { access_token: 'pp' })
    },
    {
      match: u => u.includes('/v1/billing/subscriptions/'),
      respond: () => jsonResponse(200, {
        id: 'I-PENDING',
        status: 'APPROVAL_PENDING',
        custom_id: 'user-1'
      })
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/activate-paypal-subscription.ts')];
    const { handler } = require('../../backend/functions/activate-paypal-subscription.ts');
    const res = await handler({
      httpMethod: 'POST',
      headers: makeAuthHeaders(),
      body: JSON.stringify({
        subscriptionID: 'I-PENDING',
        consentWiderrufVerzicht: true,
        consentTimestamp: new Date().toISOString()
      })
    });
    assert.equal(res.statusCode, 400, 'APPROVAL_PENDING must NOT grant Pro');
  } finally { restore(); }
});

test('activate-paypal: missing custom_id is rejected (ownership required)', async () => {
  const restore = withFetch([
    stubAuth('user-1'),
    {
      match: u => u.includes('/v1/oauth2/token'),
      respond: () => jsonResponse(200, { access_token: 'pp' })
    },
    {
      match: u => u.includes('/v1/billing/subscriptions/'),
      respond: () => jsonResponse(200, {
        id: 'I-NOOWNER',
        status: 'ACTIVE'
        // no custom_id
      })
    },
    {
      match: u => u.includes('/rest/v1/'),
      respond: () => jsonResponse(201, {})
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/activate-paypal-subscription.ts')];
    const { handler } = require('../../backend/functions/activate-paypal-subscription.ts');
    const res = await handler({
      httpMethod: 'POST',
      headers: makeAuthHeaders(),
      body: JSON.stringify({
        subscriptionID: 'I-NOOWNER',
        consentWiderrufVerzicht: true,
        consentTimestamp: new Date().toISOString()
      })
    });
    assert.equal(res.statusCode, 403, 'must require custom_id == user.id');
  } finally { restore(); }
});

test('activate-paypal: custom_id mismatch is rejected', async () => {
  const restore = withFetch([
    stubAuth('user-1'),
    {
      match: u => u.includes('/v1/oauth2/token'),
      respond: () => jsonResponse(200, { access_token: 'pp' })
    },
    {
      match: u => u.includes('/v1/billing/subscriptions/'),
      respond: () => jsonResponse(200, {
        id: 'I-WRONGOWNER',
        status: 'ACTIVE',
        custom_id: 'someone-else'
      })
    },
    {
      match: u => u.includes('/rest/v1/'),
      respond: () => jsonResponse(201, {})
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/activate-paypal-subscription.ts')];
    const { handler } = require('../../backend/functions/activate-paypal-subscription.ts');
    const res = await handler({
      httpMethod: 'POST',
      headers: makeAuthHeaders(),
      body: JSON.stringify({
        subscriptionID: 'I-WRONGOWNER',
        consentWiderrufVerzicht: true,
        consentTimestamp: new Date().toISOString()
      })
    });
    assert.equal(res.statusCode, 403);
  } finally { restore(); }
});

// -----------------------------------------------------------------------------
// (4) verify-payment: Supabase write failure must NOT return ok:true
// -----------------------------------------------------------------------------
test('verify-payment: failed DB write returns 5xx (not ok:true)', async () => {
  let writeAttempted = false;
  const restore = withFetch([
    stubAuth('user-1'),
    {
      // GET /v1/checkout/sessions/<id> from Stripe
      match: u => u.includes('/v1/checkout/sessions/'),
      respond: () => jsonResponse(200, {
        status: 'complete',
        payment_status: 'paid',
        subscription: 'sub_123',
        customer: 'cus_123',
        metadata: { user_id: 'user-1' }
      })
    },
    {
      // GET existing subscription row → none
      match: (u, init) => u.includes('/rest/v1/subscriptions') && (!init || init.method === 'GET' || init.method === undefined),
      respond: () => jsonResponse(200, [])
    },
    {
      // Stripe subscription read for period end
      match: u => u.includes('/v1/subscriptions/'),
      respond: () => jsonResponse(200, { current_period_end: Math.floor(Date.now() / 1000) + 86400 })
    },
    {
      // POST upsert into subscriptions → simulate Supabase write failure
      match: (u, init) => u.includes('/rest/v1/subscriptions') && init && init.method === 'POST',
      respond: () => { writeAttempted = true; return jsonResponse(500, { message: 'write failed' }); }
    }
  ]);
  try {
    delete require.cache[require.resolve('../../backend/functions/verify-payment.ts')];
    const { handler } = require('../../backend/functions/verify-payment.ts');
    const res = await handler({
      httpMethod: 'POST',
      headers: makeAuthHeaders(),
      body: JSON.stringify({ sessionId: 'cs_test_123' })
    });
    assert.ok(writeAttempted, 'should have attempted the upsert');
    assert.ok(res.statusCode >= 500, 'failed write must surface as 5xx, got ' + res.statusCode);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    assert.doesNotMatch(body, /"ok":\s*true/, 'must NOT report ok:true on a failed write');
  } finally { restore(); }
});

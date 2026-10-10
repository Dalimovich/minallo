import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchOpenAiMonthCost,
  fetchMathpixMonthUsage,
  _envCents,
} from '../../backend/functions/admin-users.ts';

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-07T00:00:00.000Z');

function withEnv(vars, run) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withFetch(impl, run) {
  const previous = global.fetch;
  global.fetch = impl;
  return Promise.resolve(run()).finally(() => { global.fetch = previous; });
}

test('_envCents parses a set numeric env var and ignores missing/invalid ones', () => {
  assert.equal(_envCents('MINALLO_TEST_UNSET_VAR'), undefined);
  return withEnv({ MINALLO_TEST_CENTS: 'not-a-number' }, () => {
    assert.equal(_envCents('MINALLO_TEST_CENTS'), undefined);
  }).then(() => withEnv({ MINALLO_TEST_CENTS: '5000' }, () => {
    assert.equal(_envCents('MINALLO_TEST_CENTS'), 5000);
  }));
});

test('fetchOpenAiMonthCost reports not-configured without crashing when no admin key is set', () =>
  withEnv({ OPENAI_ADMIN_KEY: undefined }, async () => {
    const result = await fetchOpenAiMonthCost(START, END);
    assert.deepEqual(result, { configured: false });
  })
);

test('fetchMathpixMonthUsage reports not-configured without crashing when no credentials are set', () =>
  withEnv({ MATHPIX_APP_ID: undefined, MATHPIX_APP_KEY: undefined }, async () => {
    const result = await fetchMathpixMonthUsage(START, END);
    assert.deepEqual(result, { configured: false });
  })
);

test('fetchOpenAiMonthCost sums amount.value across buckets and pages, in cents', () =>
  withEnv({ OPENAI_ADMIN_KEY: 'test-admin-key' }, () => withFetch(async (url) => {
    assert.match(String(url), /^https:\/\/api\.openai\.com\/v1\/organization\/costs\?/);
    const params = new URL(String(url)).searchParams;
    if (!params.get('page')) {
      return new Response(JSON.stringify({
        data: [{ results: [{ amount: { value: 1.5 } }, { amount: { value: 0.25 } }] }],
        has_more: true,
        next_page: 'cursor-2',
      }), { status: 200 });
    }
    assert.equal(params.get('page'), 'cursor-2');
    return new Response(JSON.stringify({
      data: [{ results: [{ amount: { value: 2 } }] }],
      has_more: false,
      next_page: null,
    }), { status: 200 });
  }, async () => {
    const result = await fetchOpenAiMonthCost(START, END);
    // (1.5 + 0.25 + 2) USD == 375 cents, across two paginated responses.
    assert.equal(result.configured, true);
    assert.equal(result.spentCents, 375);
    assert.equal(result.error, undefined);
  }))
);

test('fetchOpenAiMonthCost computes remaining from your own budget env var, not a provider-reported figure', () =>
  withEnv({ OPENAI_ADMIN_KEY: 'test-admin-key', OPENAI_MONTHLY_BUDGET_CENTS: '1000' }, () => withFetch(async () =>
    new Response(JSON.stringify({
      data: [{ results: [{ amount: { value: 4 } }] }],
      has_more: false,
    }), { status: 200 }),
  async () => {
    const result = await fetchOpenAiMonthCost(START, END);
    assert.equal(result.spentCents, 400);
    assert.equal(result.budgetCents, 1000);
    assert.equal(result.remainingCents, 600);
  }))
);

test('fetchOpenAiMonthCost surfaces a failed provider call as a typed error, not a throw', () =>
  withEnv({ OPENAI_ADMIN_KEY: 'test-admin-key' }, () => withFetch(async () =>
    new Response('unauthorized', { status: 401 }),
  async () => {
    const result = await fetchOpenAiMonthCost(START, END);
    assert.equal(result.configured, true);
    assert.match(result.error, /401/);
  }))
);

test('fetchMathpixMonthUsage sums request counts and never fabricates a cost/remaining figure', () =>
  withEnv({ MATHPIX_APP_ID: 'id', MATHPIX_APP_KEY: 'key' }, () => withFetch(async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.mathpix\.com\/v3\/ocr-usage\?/);
    assert.equal(init.headers.app_id, 'id');
    assert.equal(init.headers.app_key, 'key');
    return new Response(JSON.stringify({
      ocr_usage: [{ count: 10 }, { count: 5 }, {}],
    }), { status: 200 });
  }, async () => {
    const result = await fetchMathpixMonthUsage(START, END);
    assert.deepEqual(result, { configured: true, requests: 15 });
  }))
);

test('fetchMathpixMonthUsage surfaces a failed provider call as a typed error, not a throw', () =>
  withEnv({ MATHPIX_APP_ID: 'id', MATHPIX_APP_KEY: 'key' }, () => withFetch(async () =>
    new Response('rate limited', { status: 429 }),
  async () => {
    const result = await fetchMathpixMonthUsage(START, END);
    assert.equal(result.configured, true);
    assert.match(result.error, /429/);
  }))
);

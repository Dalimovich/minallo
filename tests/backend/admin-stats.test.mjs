import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketSignups,
  selectNewUsers,
  summarizeSubscriptions,
  computeRetention,
  buildMonthList,
  bucketAiByMonth,
  computeFinanceSeries,
  computeFinancials,
  tokenCostCents,
  isBucket,
  isRange,
} from '../../backend/lib/admin-stats.ts';

const CFG = {
  monthlyPriceCents: 1199,
  paymentFeePct: 0,
  paymentFeeFixedCents: 0,
  aiInteractiveCostCents: 10,
  aiGenerationCostCents: 50,
  aiInputCostCentsPerM: 300,
  aiOutputCostCentsPerM: 1500,
  supabaseCostCents: 0,
  hostingCostCents: 0,
  otherCostCents: 0,
};

const NOW = new Date('2026-06-02T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

test('isRange / isBucket guards', () => {
  assert.ok(isRange('7d') && isRange('all'));
  assert.ok(!isRange('1d'));
  assert.ok(isBucket('day') && isBucket('month'));
  assert.ok(!isBucket('year'));
});

test('bucketSignups summary buckets <7d vs >7d correctly', () => {
  const dates = [
    daysAgo(0),   // today
    daysAgo(1),   // this week
    daysAgo(3),   // this week
    daysAgo(10),  // current user (>7d)
    daysAgo(40),  // >month
    daysAgo(400), // >year
  ];
  const r = bucketSignups(dates, '30d', 'day', NOW);
  assert.equal(r.summary.total, 6);
  assert.equal(r.summary.today, 1);
  assert.equal(r.summary.week, 3);          // 0,1,3 days
  assert.equal(r.summary.month, 4);         // + 10 days
  assert.equal(r.summary.year, 5);          // + 40 days
  assert.equal(r.summary.currentUsers, 3);  // 10, 40, 400 days ago
});

test('selectNewUsers keeps only the last 24h, newest first', () => {
  const hoursAgo = (n) => new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();
  const users = [
    { id: 'a', created_at: hoursAgo(30) },  // too old
    { id: 'b', created_at: hoursAgo(2) },
    { id: 'c', created_at: hoursAgo(23) },
    { id: 'd', created_at: hoursAgo(-0.1) }, // slight clock skew → still new
    { id: 'e' },                             // no timestamp → dropped
    { id: 'f', created_at: 'not-a-date' },   // invalid → dropped
  ];
  const fresh = selectNewUsers(users, 24, NOW);
  assert.deepEqual(fresh.map((u) => u.id), ['d', 'b', 'c']);
});

test('selectNewUsers returns empty for empty input', () => {
  assert.deepEqual(selectNewUsers([], 24, NOW), []);
});

test('bucketSignups daily series sums to range total and is sorted', () => {
  const dates = [daysAgo(0), daysAgo(0), daysAgo(2), daysAgo(5)];
  const r = bucketSignups(dates, '7d', 'day', NOW);
  const seriesTotal = r.series.reduce((s, p) => s + p.count, 0);
  assert.equal(seriesTotal, r.total);
  assert.equal(r.total, 4);
  // 7 daily buckets seeded (including zeros)
  assert.equal(r.series.length, 7);
  const sorted = [...r.series].sort((a, b) => (a.date < b.date ? -1 : 1));
  assert.deepEqual(r.series.map((p) => p.date), sorted.map((p) => p.date));
});

test('bucketSignups excludes older-than-range from total but keeps it in summary', () => {
  const dates = [daysAgo(1), daysAgo(100)];
  const r = bucketSignups(dates, '7d', 'day', NOW);
  assert.equal(r.total, 1);          // only the 1-day-old one is in the 7d window
  assert.equal(r.summary.total, 2);  // both counted overall
});

test('bucketSignups monthly bucket keys are YYYY-MM', () => {
  const r = bucketSignups([daysAgo(0)], '365d', 'month', NOW);
  assert.ok(r.series.every((p) => /^\d{4}-\d{2}$/.test(p.date)));
  assert.equal(r.series[r.series.length - 1].date, '2026-06');
});

test('summarizeSubscriptions counts plans/statuses + conversion rate', () => {
  const rows = [
    { plan: 'pro', status: 'active', had_trial: true },     // active paid + converted
    { plan: 'pro', status: 'trialing', had_trial: true },   // trialing (not converted)
    { plan: 'pro', status: 'cancelled', had_trial: true },  // cancelled + converted
    { plan: 'pro', status: 'active', had_trial: false },    // active paid (no trial)
    { plan: 'free', status: 'none', had_trial: false },
  ];
  const s = summarizeSubscriptions(rows);
  assert.equal(s.totalSubs, 5);
  assert.equal(s.activePaid, 2);
  assert.equal(s.trialing, 1);
  assert.equal(s.cancelled, 1);
  assert.equal(s.trialsStarted, 3);
  assert.equal(s.converted, 2);                 // active+trial, cancelled+trial
  assert.equal(s.conversionRate, 66.7);         // 2/3
});

test('summarizeSubscriptions handles no trials (rate 0)', () => {
  const s = summarizeSubscriptions([{ plan: 'pro', status: 'active', had_trial: false }]);
  assert.equal(s.conversionRate, 0);
  assert.equal(s.activePaid, 1);
});

test('computeRetention tracks active across months and churn', () => {
  // User A: pays Apr, renews May, cancels Jun.
  // User B: pays May, still active Jun.
  const events = [
    { user_id: 'A', event_type: 'paid', created_at: '2026-04-10T00:00:00Z' },
    { user_id: 'A', event_type: 'renewed', created_at: '2026-05-10T00:00:00Z' },
    { user_id: 'A', event_type: 'cancelled', created_at: '2026-06-05T00:00:00Z' },
    { user_id: 'B', event_type: 'paid', created_at: '2026-05-20T00:00:00Z' },
  ];
  const series = computeRetention(events, 3, NOW); // Apr, May, Jun
  assert.equal(series.length, 3);
  const [apr, may, jun] = series;

  assert.equal(apr.month, '2026-04');
  assert.equal(apr.active, 1);   // A
  assert.equal(apr.newPaid, 1);  // A

  assert.equal(may.month, '2026-05');
  assert.equal(may.active, 2);   // A still in, B joins
  assert.equal(may.newPaid, 1);  // B
  assert.equal(may.renewed, 1);  // A renewed

  assert.equal(jun.month, '2026-06');
  assert.equal(jun.active, 1);     // A cancelled, B remains
  assert.equal(jun.cancelled, 1);  // A
});

test('computeRetention ignores events without a user', () => {
  const series = computeRetention(
    [{ user_id: null, event_type: 'paid', created_at: '2026-06-01T00:00:00Z' }],
    1, NOW
  );
  assert.equal(series[0].active, 0);
});

// ── Finance series ────────────────────────────────────────────────────────────
test('buildMonthList returns oldest→newest ending in current month', () => {
  const list = buildMonthList(3, NOW);
  assert.deepEqual(list, ['2026-04', '2026-05', '2026-06']);
});

test('bucketAiByMonth splits interactive vs generation per month', () => {
  const by = bucketAiByMonth([
    { event_type: 'ai_ask', created_at: '2026-05-10T00:00:00Z' },
    { event_type: 'ask_stream', created_at: '2026-05-20T00:00:00Z' },
    { event_type: 'ai_generate', created_at: '2026-05-21T00:00:00Z' },
    { event_type: 'notes_generate', created_at: '2026-06-01T00:00:00Z' },
    { event_type: 'ai_ask', created_at: 'not-a-date' },
  ]);
  assert.deepEqual(by['2026-05'], { interactive: 2, generation: 1 });
  assert.deepEqual(by['2026-06'], { interactive: 0, generation: 1 });
});

test('computeFinanceSeries computes revenue/cost/profit per month', () => {
  const cfg = {
    monthlyPriceCents: 1000,
    paymentFeePct: 10,
    paymentFeeFixedCents: 0,
    aiInteractiveCostCents: 1,
    aiGenerationCostCents: 5,
    supabaseCostCents: 200,
    hostingCostCents: 0,
    otherCostCents: 0,
  };
  const series = computeFinanceSeries(
    ['2026-05', '2026-06'],
    { '2026-05': 0, '2026-06': 2 },
    { '2026-06': { interactive: 10, generation: 4 } },
    cfg
  );
  // May: no activity → all zero, fixed cost suppressed.
  assert.deepEqual(series[0], {
    month: '2026-05', revenueCents: 0, aiCostCents: 0, feesCents: 0,
    fixedCents: 0, costCents: 0, profitCents: 0, activePaid: 0, aiCalls: 0,
  });
  // June: 2 paid × €10 = 2000 revenue; fees 10% = 200; ai = 10×1 + 4×5 = 30;
  // fixed = 200; cost = 430; profit = 1570.
  assert.equal(series[1].revenueCents, 2000);
  assert.equal(series[1].feesCents, 200);
  assert.equal(series[1].aiCostCents, 30);
  assert.equal(series[1].fixedCents, 200);
  assert.equal(series[1].costCents, 430);
  assert.equal(series[1].profitCents, 1570);
  assert.equal(series[1].aiCalls, 14);
});

// ── AI usage meter (usage_events) ────────────────────────────────────────────

test('modelPrice prefix-matches and falls back to config rates', async () => {
  const { modelPrice } = await import('../../backend/lib/admin-stats.ts');
  assert.equal(modelPrice('gpt-4o-mini-2024-07-18', CFG).input, 15);
  assert.equal(modelPrice('gpt-4o-2024-08-06', CFG).input, 250);
  assert.equal(modelPrice('o4-mini-2025-04-16', CFG).output, 440);
  // Unknown model -> config rates, never 0.
  const fb = modelPrice('some-future-model', CFG);
  assert.equal(fb.input, CFG.aiInputCostCentsPerM);
  assert.equal(fb.output, CFG.aiOutputCostCentsPerM);
});

test('computeAiUsage aggregates per feature x model with cached pricing', async () => {
  const { computeAiUsage } = await import('../../backend/lib/admin-stats.ts');
  const rows = [
    // 1M uncached input + 0.1M output on mini: 15 + 6 = 21 cents
    { user_id: 'u1', feature: 'ask_stream', model: 'gpt-4o-mini-2024-07-18',
      prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_tokens: 0 },
    // 1M input fully cached on mini: 7.5 cents
    { user_id: 'u1', feature: 'ask_stream', model: 'gpt-4o-mini-2024-07-18',
      prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 1_000_000 },
    // unattributed embeddings: 1M x 2 cents
    { user_id: null, feature: 'embeddings', model: 'text-embedding-3-small',
      prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 0 },
  ];
  const out = computeAiUsage(rows, CFG);
  assert.equal(out.totalRequests, 3);
  assert.equal(out.lines.length, 2);
  const ask = out.lines.find((l) => l.feature === 'ask_stream');
  assert.equal(ask.requests, 2);
  assert.equal(ask.costCents, 28.5);
  assert.equal(out.unattributedCostCents, 2);
  assert.equal(out.totalCostCents, 30.5);
  assert.equal(out.perUserCostCents.get('u1'), 28.5);
});

test('computeFinancials: meteredCostCents overrides both estimates', () => {
  const users = [
    { userId: 'a', interactive: 100, generation: 10, paid: true, meteredCostCents: 42 },
  ];
  const r = computeFinancials(users, CFG);
  // Without metering this would be 100x10 + 10x50 = 1500 cents.
  assert.equal(r.aiCostCents, 42);
  assert.equal(r.measuredAiCostCents, 42);
  assert.equal(r.estimatedAiCostCents, 0);
});

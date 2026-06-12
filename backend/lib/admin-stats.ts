// Pure aggregation helpers for the admin analytics endpoint.
//
// These are deliberately free of any network/Supabase access so they can be
// unit-tested directly (see tests/backend/admin-stats.test.mjs). The handler in
// functions/admin-users.ts fetches the raw rows (signup timestamps,
// subscription rows, subscription_events) and feeds them in here.

export type Bucket = 'day' | 'week' | 'month';
export type Range = '7d' | '30d' | '90d' | '365d' | 'all';

export const RANGE_DAYS: Record<Range, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
  all: null
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isBucket(v: unknown): v is Bucket {
  return v === 'day' || v === 'week' || v === 'month';
}
export function isRange(v: unknown): v is Range {
  return v === '7d' || v === '30d' || v === '90d' || v === '365d' || v === 'all';
}

// ── UTC bucket math ─────────────────────────────────────────────────────────
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function startOfUtcWeek(d: Date): Date {
  // ISO week — weeks start on Monday.
  const s = startOfUtcDay(d);
  const dow = (s.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  s.setUTCDate(s.getUTCDate() - dow);
  return s;
}
function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function bucketStart(d: Date, b: Bucket): Date {
  if (b === 'month') return startOfUtcMonth(d);
  if (b === 'week') return startOfUtcWeek(d);
  return startOfUtcDay(d);
}
function bucketKey(d: Date, b: Bucket): string {
  const s = bucketStart(d, b);
  return b === 'month' ? s.toISOString().slice(0, 7) : s.toISOString().slice(0, 10);
}
function nextBucket(d: Date, b: Bucket): Date {
  const n = new Date(d);
  if (b === 'month') n.setUTCMonth(n.getUTCMonth() + 1);
  else n.setUTCDate(n.getUTCDate() + (b === 'week' ? 7 : 1));
  return n;
}

// ── Signups ─────────────────────────────────────────────────────────────────
export interface SignupSummary {
  today: number;
  week: number;
  month: number;
  year: number;
  total: number;
  currentUsers: number; // signed up more than 7 days ago
}
export interface SignupResult {
  total: number; // total within the selected range
  range: Range;
  bucket: Bucket;
  series: Array<{ date: string; count: number }>;
  summary: SignupSummary;
}

export function bucketSignups(
  createdAts: Array<string | number | Date>,
  range: Range,
  bucket: Bucket,
  now: Date = new Date()
): SignupResult {
  const dates: Date[] = [];
  for (const c of createdAts) {
    const d = c instanceof Date ? c : new Date(c);
    if (!isNaN(d.getTime())) dates.push(d);
  }
  const nowMs = now.getTime();

  const summary: SignupSummary = {
    today: dates.filter((d) => d.getTime() >= startOfUtcDay(now).getTime()).length,
    week: dates.filter((d) => nowMs - d.getTime() < 7 * DAY_MS).length,
    month: dates.filter((d) => nowMs - d.getTime() < 30 * DAY_MS).length,
    year: dates.filter((d) => nowMs - d.getTime() < 365 * DAY_MS).length,
    total: dates.length,
    currentUsers: dates.filter((d) => nowMs - d.getTime() >= 7 * DAY_MS).length
  };

  // Range start, snapped to a bucket boundary.
  const rd = RANGE_DAYS[range];
  let from: Date;
  if (rd == null) {
    let earliest = nowMs;
    for (const d of dates) if (d.getTime() < earliest) earliest = d.getTime();
    from = bucketStart(new Date(earliest), bucket);
  } else {
    from = bucketStart(new Date(nowMs - (rd - 1) * DAY_MS), bucket);
  }

  // Seed every bucket in the window with 0 so the chart shows gaps.
  const counts = new Map<string, number>();
  const end = bucketStart(now, bucket);
  for (let cur = new Date(from); cur.getTime() <= end.getTime(); cur = nextBucket(cur, bucket)) {
    counts.set(bucketKey(cur, bucket), 0);
  }

  let total = 0;
  for (const d of dates) {
    if (d.getTime() < from.getTime()) continue;
    const k = bucketKey(d, bucket);
    if (counts.has(k)) {
      counts.set(k, (counts.get(k) || 0) + 1);
      total++;
    }
  }

  const series = Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { total, range, bucket, series, summary };
}

// ── New users (signed up within the last N hours) ────────────────────────────
// Pure filter + sort so the cutoff logic is unit-testable; the handler feeds in
// the auth-users page scan. Newest first. Timestamps slightly in the future
// (clock skew between Auth and this function) still count as "new".
export function selectNewUsers<T extends { created_at?: string }>(
  users: T[],
  hours: number,
  now: Date = new Date()
): T[] {
  const cutoffMs = now.getTime() - hours * 60 * 60 * 1000;
  return users
    .filter((u) => {
      if (!u.created_at) return false;
      const t = new Date(u.created_at).getTime();
      return Number.isFinite(t) && t >= cutoffMs;
    })
    .sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime());
}

// ── Subscription snapshot (from current `subscriptions` rows) ────────────────
export interface SubRow {
  plan?: string | null;
  status?: string | null;
  had_trial?: boolean | null;
}
export interface SubSummary {
  totalSubs: number;
  trialsStarted: number;
  converted: number;
  conversionRate: number; // percent, 1 decimal
  activePaid: number;
  trialing: number;
  cancelled: number;
  pastDue: number;
  paused: number;
}

export function summarizeSubscriptions(rows: SubRow[]): SubSummary {
  let trialsStarted = 0, converted = 0, activePaid = 0, trialing = 0,
    cancelled = 0, pastDue = 0, paused = 0;

  for (const r of rows) {
    const status = String(r.status || '').toLowerCase();
    const plan = String(r.plan || '').toLowerCase();
    const hadTrial = !!r.had_trial;

    if (hadTrial) trialsStarted++;
    if (status === 'trialing') trialing++;
    else if (plan === 'pro' && status === 'active') activePaid++;
    else if (status === 'cancelled' || status === 'expired') cancelled++;
    else if (status === 'past_due') pastDue++;
    else if (status === 'paused') paused++;

    // Approx trial→paid conversion from current state: had a trial and is no
    // longer trialing (i.e. moved on to paying, or paid-then-cancelled).
    if (hadTrial && status && status !== 'trialing' && status !== 'none') converted++;
  }

  const conversionRate =
    trialsStarted > 0 ? Math.round((converted / trialsStarted) * 1000) / 10 : 0;

  return {
    totalSubs: rows.length,
    trialsStarted, converted, conversionRate,
    activePaid, trialing, cancelled, pastDue, paused
  };
}

// ── Monthly retention (from subscription_events history) ─────────────────────
export interface SubEvent {
  user_id?: string | null;
  event_type?: string | null;
  created_at?: string | number | Date | null;
}
export interface RetentionMonth {
  month: string; // YYYY-MM
  active: number; // distinct paying users by end of month
  newPaid: number; // users whose first paid/converted event is this month
  renewed: number; // users with a renewal this month
  cancelled: number; // users who cancelled/expired this month
}

// ── Financial overview ───────────────────────────────────────────────────────
// Revenue + cost + profit, computed from real subscription rows and the monthly
// AI request counts (security_events), plus the editable cost config. All money
// in integer cents in, rounded cents out.
export interface CostConfig {
  monthlyPriceCents: number;
  paymentFeePct: number;            // e.g. 2.9 (%)
  paymentFeeFixedCents: number;     // e.g. 35 (per paying user / transaction)
  aiInteractiveCostCents: number;   // estimated cost per interactive AI call
  aiGenerationCostCents: number;    // estimated cost per generation AI call
  aiInputCostCentsPerM: number;     // measured: cents per 1M input (prompt) tokens
  aiOutputCostCentsPerM: number;    // measured: cents per 1M output (completion) tokens
  supabaseCostCents: number;
  hostingCostCents: number;
  otherCostCents: number;
}

// Per-user monthly AI usage + whether they're a paying (pro/active) user.
// `interactiveTokenCostCents`, when provided, is the REAL token-metered cost of
// this user's interactive (ask/stream) calls — it overrides the per-call
// estimate for that portion. Generation calls stay estimate-based.
// `meteredCostCents`, when provided, is the FULLY metered total AI cost for
// this user (all features, from usage_events) and overrides BOTH estimates.
export interface UserUsage {
  userId: string;
  email?: string;
  interactive: number;
  generation: number;
  paid: boolean;
  interactiveTokenCostCents?: number;
  meteredCostCents?: number;
}

// ── Per-model OpenAI pricing (cents per 1M tokens) ───────────────────────────
// Prefix-matched against the model string from usage_events (model ids carry
// date suffixes like gpt-4o-2024-08-06). `cached` is the discounted price for
// prompt tokens served from OpenAI's prompt cache. Unknown models fall back
// to the editable config rates so a new model never silently costs 0.
export interface ModelPrice { input: number; cached: number; output: number }
export const MODEL_PRICES_CENTS_PER_M: Array<{ prefix: string; price: ModelPrice }> = [
  // Order matters: longer/more specific prefixes first.
  { prefix: 'gpt-4o-mini',            price: { input: 15,  cached: 7.5,  output: 60 } },
  { prefix: 'gpt-4o',                 price: { input: 250, cached: 125,  output: 1000 } },
  { prefix: 'gpt-4.1-mini',           price: { input: 40,  cached: 10,   output: 160 } },
  { prefix: 'gpt-4.1-nano',           price: { input: 10,  cached: 2.5,  output: 40 } },
  { prefix: 'gpt-4.1',                price: { input: 200, cached: 50,   output: 800 } },
  { prefix: 'o4-mini',                price: { input: 110, cached: 27.5, output: 440 } },
  { prefix: 'o3-mini',                price: { input: 110, cached: 55,   output: 440 } },
  { prefix: 'text-embedding-3-small', price: { input: 2,   cached: 2,    output: 0 } },
  { prefix: 'text-embedding-3-large', price: { input: 13,  cached: 13,   output: 0 } }
];

export function modelPrice(model: string, cfg: CostConfig): ModelPrice {
  const m = (model || '').toLowerCase();
  for (const entry of MODEL_PRICES_CENTS_PER_M) {
    if (m.startsWith(entry.prefix)) return entry.price;
  }
  return { input: cfg.aiInputCostCentsPerM, cached: cfg.aiInputCostCentsPerM, output: cfg.aiOutputCostCentsPerM };
}

// One usage_events row (token counts only — cost derived here at read time).
export interface UsageEventRow {
  user_id?: string | null;
  feature?: string | null;
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
}

export function usageEventCostCents(row: UsageEventRow, cfg: CostConfig): number {
  const price = modelPrice(String(row.model || ''), cfg);
  const prompt = Number(row.prompt_tokens) || 0;
  const cached = Math.min(Number(row.cached_tokens) || 0, prompt);
  const output = Number(row.completion_tokens) || 0;
  // Cached tokens are part of prompt_tokens but billed at the cached rate.
  return ((prompt - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
}

export interface AiUsageLine {
  feature: string;
  model: string;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costCents: number;        // rounded to 2 decimals (sub-cent features matter)
}

export interface AiUsageSummary {
  lines: AiUsageLine[];               // sorted by cost, highest first
  totalCostCents: number;
  totalRequests: number;
  unattributedCostCents: number;      // rows with no user_id (indexing, embeddings…)
  perUserCostCents: Map<string, number>;
}

// Aggregate raw usage_events rows into the admin "AI Usage" breakdown.
export function computeAiUsage(rows: UsageEventRow[], cfg: CostConfig): AiUsageSummary {
  const byKey = new Map<string, AiUsageLine>();
  const perUser = new Map<string, number>();
  let totalCost = 0;
  let unattributed = 0;
  for (const r of rows) {
    const feature = String(r.feature || 'unknown');
    const model = String(r.model || 'unknown');
    const cost = usageEventCostCents(r, cfg);
    totalCost += cost;
    const uid = r.user_id ? String(r.user_id) : '';
    if (uid) perUser.set(uid, (perUser.get(uid) || 0) + cost);
    else unattributed += cost;
    const key = feature + ' ' + model;
    const line = byKey.get(key) || {
      feature, model, requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costCents: 0
    };
    line.requests += 1;
    line.promptTokens += Number(r.prompt_tokens) || 0;
    line.cachedTokens += Number(r.cached_tokens) || 0;
    line.completionTokens += Number(r.completion_tokens) || 0;
    line.costCents += cost;
    byKey.set(key, line);
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const lines = Array.from(byKey.values())
    .map((l) => ({ ...l, costCents: round2(l.costCents) }))
    .sort((a, b) => b.costCents - a.costCents);
  return {
    lines,
    totalCostCents: round2(totalCost),
    totalRequests: rows.length,
    unattributedCostCents: round2(unattributed),
    perUserCostCents: perUser
  };
}

// Compute the measured token cost (in cents) from raw token counts + config.
export function tokenCostCents(
  promptTokens: number,
  completionTokens: number,
  cfg: CostConfig
): number {
  return (
    (promptTokens * cfg.aiInputCostCentsPerM + completionTokens * cfg.aiOutputCostCentsPerM) / 1_000_000
  );
}

export interface DangerUser {
  userId: string;
  email?: string;
  paid: boolean;
  revenueCents: number;
  aiCostCents: number;
  feeCents: number;
  profitCents: number;
  interactive: number;
  generation: number;
  flag: 'loss' | 'high' | 'ok';
}

export interface FinancialResult {
  activePaid: number;
  totalUsersWithUsage: number;
  mrrCents: number;
  revenueCents: number;            // monthly subscription revenue
  aiCostCents: number;
  paymentFeesCents: number;
  fixedCostsCents: number;
  netProfitCents: number;
  profitMargin: number;            // percent, 1 decimal
  aiCostPerUserCents: number;      // across all users with usage
  aiCostPerPaidUserCents: number;
  profitPerPaidUserCents: number;
  interactiveCalls: number;
  generationCalls: number;
  measuredAiCostCents: number;     // portion of aiCost from real token metering
  estimatedAiCostCents: number;    // portion still based on per-call estimates
  dangerUsers: DangerUser[];
  config: CostConfig;
}

function _round(n: number): number {
  return Math.round(n);
}

export function computeFinancials(
  users: UserUsage[],
  cfg: CostConfig,
  dangerLimit = 15
): FinancialResult {
  const price = cfg.monthlyPriceCents;
  const perPaidFeeCents = (u: { paid: boolean }) =>
    u.paid ? (price * cfg.paymentFeePct) / 100 + cfg.paymentFeeFixedCents : 0;

  let activePaid = 0;
  let interactiveCalls = 0;
  let generationCalls = 0;
  let aiCostCents = 0;
  let measuredAiCostCents = 0;
  let estimatedAiCostCents = 0;

  const rows: DangerUser[] = [];
  for (const u of users) {
    if (u.paid) activePaid++;
    interactiveCalls += u.interactive;
    generationCalls += u.generation;
    // Cost precedence: fully metered (usage_events, all features) > interactive
    // token metering (retrieval_debug_log) + generation estimate > per-call
    // estimates for everything.
    const fullyMetered = typeof u.meteredCostCents === 'number';
    const measured = typeof u.interactiveTokenCostCents === 'number';
    let userAiCost: number;
    if (fullyMetered) {
      userAiCost = u.meteredCostCents as number;
      measuredAiCostCents += userAiCost;
    } else if (measured) {
      const interactiveCost = u.interactiveTokenCostCents as number;
      const generationCost = u.generation * cfg.aiGenerationCostCents;
      userAiCost = interactiveCost + generationCost;
      measuredAiCostCents += interactiveCost;
      estimatedAiCostCents += generationCost;
    } else {
      userAiCost = u.interactive * cfg.aiInteractiveCostCents + u.generation * cfg.aiGenerationCostCents;
      estimatedAiCostCents += userAiCost;
    }
    aiCostCents += userAiCost;

    const revenueCents = u.paid ? price : 0;
    const feeCents = perPaidFeeCents(u);
    const profitCents = revenueCents - userAiCost - feeCents;
    // Flag a paying user who costs more than they bring in, or a heavy user.
    let flag: DangerUser['flag'] = 'ok';
    if (u.paid && profitCents < 0) flag = 'loss';
    else if (userAiCost > price) flag = 'high';
    rows.push({
      userId: u.userId,
      email: u.email,
      paid: u.paid,
      revenueCents: _round(revenueCents),
      aiCostCents: _round(userAiCost),
      feeCents: _round(feeCents),
      profitCents: _round(profitCents),
      interactive: u.interactive,
      generation: u.generation,
      flag
    });
  }

  const mrrCents = activePaid * price;
  const revenueCents = mrrCents; // monthly recurring revenue = monthly revenue here
  const paymentFeesCents = activePaid * ((price * cfg.paymentFeePct) / 100 + cfg.paymentFeeFixedCents);
  const fixedCostsCents = cfg.supabaseCostCents + cfg.hostingCostCents + cfg.otherCostCents;
  const netProfitCents = revenueCents - aiCostCents - paymentFeesCents - fixedCostsCents;
  const profitMargin =
    revenueCents > 0 ? Math.round((netProfitCents / revenueCents) * 1000) / 10 : 0;

  const usersWithUsage = users.filter((u) => u.interactive > 0 || u.generation > 0).length;
  const paidAiCost = users
    .filter((u) => u.paid)
    .reduce((s, u) => {
      if (typeof u.meteredCostCents === 'number') return s + u.meteredCostCents;
      const interactiveCost = typeof u.interactiveTokenCostCents === 'number'
        ? u.interactiveTokenCostCents
        : u.interactive * cfg.aiInteractiveCostCents;
      return s + interactiveCost + u.generation * cfg.aiGenerationCostCents;
    }, 0);

  const dangerUsers = rows
    .filter((r) => r.aiCostCents > 0 || r.paid)
    .sort((a, b) => a.profitCents - b.profitCents) // worst (most negative) first
    .slice(0, dangerLimit);

  return {
    activePaid,
    totalUsersWithUsage: usersWithUsage,
    mrrCents: _round(mrrCents),
    revenueCents: _round(revenueCents),
    aiCostCents: _round(aiCostCents),
    paymentFeesCents: _round(paymentFeesCents),
    fixedCostsCents: _round(fixedCostsCents),
    netProfitCents: _round(netProfitCents),
    profitMargin,
    aiCostPerUserCents: usersWithUsage > 0 ? _round(aiCostCents / usersWithUsage) : 0,
    aiCostPerPaidUserCents: activePaid > 0 ? _round(paidAiCost / activePaid) : 0,
    profitPerPaidUserCents: activePaid > 0 ? _round(netProfitCents / activePaid) : 0,
    interactiveCalls,
    generationCalls,
    measuredAiCostCents: _round(measuredAiCostCents),
    estimatedAiCostCents: _round(estimatedAiCostCents),
    dangerUsers,
    config: cfg
  };
}

// ── Monthly finance trend (revenue / cost / profit over time) ────────────────
// Real series built from: active-paid-per-month (retention history, overridden
// with the live count for the current month) + AI request counts bucketed by
// month + the editable cost config. Money in/out is integer cents.
export interface FinanceSeriesPoint {
  month: string;          // YYYY-MM
  revenueCents: number;
  aiCostCents: number;
  feesCents: number;
  fixedCents: number;
  costCents: number;      // ai + fees + fixed
  profitCents: number;
  activePaid: number;
  aiCalls: number;
}

// Build the oldest→newest list of YYYY-MM month keys ending in the current month.
export function buildMonthList(months: number, now: Date = new Date()): string[] {
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

// Bucket AI events into per-month interactive/generation counts.
export function bucketAiByMonth(
  events: UsageEvent[]
): Record<string, { interactive: number; generation: number }> {
  const GEN = new Set(['ai_generate', 'notes_generate']);
  const out: Record<string, { interactive: number; generation: number }> = {};
  for (const e of events) {
    const d = e.created_at instanceof Date ? e.created_at : new Date(e.created_at as string);
    if (isNaN(d.getTime())) continue;
    const k = d.toISOString().slice(0, 7);
    const o = out[k] || (out[k] = { interactive: 0, generation: 0 });
    if (GEN.has(String(e.event_type))) o.generation++;
    else o.interactive++;
  }
  return out;
}

export function computeFinanceSeries(
  monthsList: string[],
  activeByMonth: Record<string, number>,
  aiByMonth: Record<string, { interactive: number; generation: number }>,
  cfg: CostConfig
): FinanceSeriesPoint[] {
  const fixed = cfg.supabaseCostCents + cfg.hostingCostCents + cfg.otherCostCents;
  return monthsList.map((m) => {
    const active = activeByMonth[m] || 0;
    const ai = aiByMonth[m] || { interactive: 0, generation: 0 };
    const aiCost = ai.interactive * cfg.aiInteractiveCostCents + ai.generation * cfg.aiGenerationCostCents;
    const revenue = active * cfg.monthlyPriceCents;
    const fees = active * ((cfg.monthlyPriceCents * cfg.paymentFeePct) / 100 + cfg.paymentFeeFixedCents);
    // Fixed infra cost only applies once the business is live (any activity).
    const fixedThis = active > 0 || ai.interactive + ai.generation > 0 ? fixed : 0;
    const cost = aiCost + fees + fixedThis;
    return {
      month: m,
      revenueCents: _round(revenue),
      aiCostCents: _round(aiCost),
      feesCents: _round(fees),
      fixedCents: _round(fixedThis),
      costCents: _round(cost),
      profitCents: _round(revenue - cost),
      activePaid: active,
      aiCalls: ai.interactive + ai.generation
    };
  });
}

// ── Activity & feature usage ─────────────────────────────────────────────────
// DAU/WAU/MAU (distinct active users) + per-feature counts this month, computed
// from a unified event stream: AI events (security_events) + chat messages
// (mapped to a synthetic 'chat_message' type by the handler).
export interface UsageEvent {
  user_id?: string | null;
  event_type?: string | null;
  created_at?: string | number | Date | null;
}
export interface UsageResult {
  dau: number;
  wau: number;
  mau: number;
  features: Array<{ key: string; label: string; count: number }>;
}

const _FEATURE_GROUPS: Array<{ key: string; label: string; types: string[] }> = [
  { key: 'asks', label: 'AI chat / asks', types: ['ai_ask', 'ai_chat', 'ask_stream'] },
  { key: 'generations', label: 'Quiz / flashcards', types: ['ai_generate'] },
  { key: 'notes', label: 'Notes summaries', types: ['notes_generate'] },
  { key: 'writing', label: 'Writing coach', types: ['writing_coach_analyse'] },
  { key: 'chat', label: 'Chat messages', types: ['chat_message'] }
];

export function computeUsage(events: UsageEvent[], now: Date = new Date()): UsageResult {
  const nowMs = now.getTime();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const dayUsers = new Set<string>();
  const weekUsers = new Set<string>();
  const monthUsers = new Set<string>();
  const counts: Record<string, number> = {};

  for (const e of events) {
    const uid = e.user_id ? String(e.user_id) : '';
    const d = e.created_at instanceof Date ? e.created_at : new Date(e.created_at as string);
    const t = d.getTime();
    if (isNaN(t)) continue;
    const age = nowMs - t;
    if (uid) {
      if (age < DAY_MS) dayUsers.add(uid);
      if (age < 7 * DAY_MS) weekUsers.add(uid);
      if (age < 30 * DAY_MS) monthUsers.add(uid);
    }
    // Feature counts are calendar-month-to-date.
    if (t >= monthStart) {
      const type = String(e.event_type || '');
      counts[type] = (counts[type] || 0) + 1;
    }
  }

  const features = _FEATURE_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    count: g.types.reduce((s, t) => s + (counts[t] || 0), 0)
  }));

  return { dau: dayUsers.size, wau: weekUsers.size, mau: monthUsers.size, features };
}

const PAID_EVENTS = new Set(['paid', 'converted', 'renewed']);
const END_EVENTS = new Set(['cancelled', 'expired']);

export function computeRetention(
  events: SubEvent[],
  months: number,
  now: Date = new Date()
): RetentionMonth[] {
  // Normalize + sort events per user.
  interface E { type: string; t: number; }
  const byUser = new Map<string, E[]>();
  let firstPaid = new Map<string, number>();
  for (const ev of events) {
    const uid = ev.user_id ? String(ev.user_id) : '';
    if (!uid) continue;
    const type = String(ev.event_type || '').toLowerCase();
    const d = ev.created_at instanceof Date ? ev.created_at : new Date(ev.created_at as string);
    if (isNaN(d.getTime())) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push({ type, t: d.getTime() });
    if (PAID_EVENTS.has(type)) {
      const cur = firstPaid.get(uid);
      if (cur == null || d.getTime() < cur) firstPaid.set(uid, d.getTime());
    }
  }
  for (const list of byUser.values()) list.sort((a, b) => a.t - b.t);

  // Build the list of months (oldest → newest), ending with the current month.
  const monthStarts: Date[] = [];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = months - 1; i >= 0; i--) {
    monthStarts.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1)));
  }

  const out: RetentionMonth[] = [];
  for (const mStart of monthStarts) {
    const mEnd = new Date(Date.UTC(mStart.getUTCFullYear(), mStart.getUTCMonth() + 1, 1));
    const key = mStart.toISOString().slice(0, 7);
    const mStartMs = mStart.getTime(), mEndMs = mEnd.getTime();

    let newPaid = 0, renewed = 0, cancelled = 0, active = 0;

    // Per-user month metrics.
    for (const [uid, list] of byUser) {
      let renewedThis = false, cancelledThis = false;
      for (const e of list) {
        if (e.t >= mStartMs && e.t < mEndMs) {
          if (e.type === 'renewed') renewedThis = true;
          if (END_EVENTS.has(e.type)) cancelledThis = true;
        }
      }
      if (renewedThis) renewed++;
      if (cancelledThis) cancelled++;

      const fp = firstPaid.get(uid);
      if (fp != null && fp >= mStartMs && fp < mEndMs) newPaid++;

      // Active by end of month = latest relevant event before mEnd is a paying
      // one (i.e. they are still subscribed at the month boundary).
      let lastType: string | null = null;
      for (const e of list) {
        if (e.t >= mEndMs) break;
        if (PAID_EVENTS.has(e.type) || END_EVENTS.has(e.type)) lastType = e.type;
      }
      if (lastType && PAID_EVENTS.has(lastType)) active++;
    }

    out.push({ month: key, active, newPaid, renewed, cancelled });
  }

  return out;
}

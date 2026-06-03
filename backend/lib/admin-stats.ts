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
  supabaseCostCents: number;
  hostingCostCents: number;
  otherCostCents: number;
}

// Per-user monthly AI usage + whether they're a paying (pro/active) user.
export interface UserUsage {
  userId: string;
  email?: string;
  interactive: number;
  generation: number;
  paid: boolean;
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

  const rows: DangerUser[] = [];
  for (const u of users) {
    if (u.paid) activePaid++;
    interactiveCalls += u.interactive;
    generationCalls += u.generation;
    const userAiCost =
      u.interactive * cfg.aiInteractiveCostCents + u.generation * cfg.aiGenerationCostCents;
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
    .reduce((s, u) => s + u.interactive * cfg.aiInteractiveCostCents + u.generation * cfg.aiGenerationCostCents, 0);

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
    dangerUsers,
    config: cfg
  };
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

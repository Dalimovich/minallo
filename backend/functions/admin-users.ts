import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { supaRequest, supaAuthAdminRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { logSecurityEvent } from '../lib/logger';
import { isUuid } from '../lib/validation';
import {
  bucketSignups, summarizeSubscriptions, computeRetention, computeFinancials,
  isBucket, isRange, RANGE_DAYS, type Bucket, type Range, type SubRow, type SubEvent,
  type CostConfig, type UserUsage
} from '../lib/admin-stats';
import type { LambdaResponse, NetlifyEvent, SupabaseUser } from '../lib/types';

// Smart default bucket per range so charts stay readable (a year of daily bars
// is unusable). Used only when the caller didn't specify a valid bucket.
function defaultBucket(range: Range): Bucket {
  if (range === '365d' || range === 'all') return 'month';
  if (range === '90d') return 'week';
  return 'day';
}

// Page through the Auth Admin API collecting signup timestamps. This needs no
// DB migration and is fine for launch-scale user counts; if it ever gets slow,
// swap in a SECURITY DEFINER RPC over auth.users.
async function collectSignupTimestamps(serviceKey: string): Promise<string[]> {
  const out: string[] = [];
  const PER_PAGE = 1000;
  let page = 1;
  for (; page <= 100; page++) {
    const res = await supaAuthAdminRequest<{ users?: Array<{ created_at?: string }> }>(
      'GET', 'users?per_page=' + PER_PAGE + '&page=' + page, serviceKey
    );
    if (res.status < 200 || res.status >= 300) break;
    const users = (res.body && res.body.users) || [];
    for (const u of users) if (u.created_at) out.push(u.created_at);
    if (users.length < PER_PAGE) break;
  }
  return out;
}

interface AdminRow { user_id: string }
interface SubscriptionLite { plan?: string; status?: string }
interface UsersListResponse { users?: SupabaseUser[] }

async function checkAdmin(user: SupabaseUser, serviceKey: string): Promise<{ ok: boolean; method: string }> {
  const adminRes = await supaRequest<AdminRow[]>(
    'GET',
    'admins?user_id=eq.' + encodeURIComponent(user.id) + '&select=user_id&limit=1',
    null, serviceKey
  );
  const rows = Array.isArray(adminRes.body) ? adminRes.body : [];
  if (rows[0] && rows[0].user_id === user.id) return { ok: true, method: 'admins_table' };
  return { ok: false, method: 'none' };
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  let action: unknown, query = '', userId: unknown, plan: unknown,
      reportId: unknown, status: unknown, resolutionNote = '',
      range: unknown, bucket: unknown, months: unknown, config: unknown;
  try {
    const b = JSON.parse(event.body || '{}') as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'Invalid body');
    action = b.action;
    query = String(b.query || '').trim();
    userId = b.userId;
    plan = b.plan;
    reportId = b.reportId;
    status = b.status;
    resolutionNote = typeof b.resolutionNote === 'string' ? b.resolutionNote.trim() : '';
    range = b.range;
    bucket = b.bucket;
    months = b.months;
    config = b.config;
  } catch { return fail(400, 'Invalid body'); }

  const callerToken = extractBearerToken(event.headers);
  if (!callerToken) return fail(401, 'Unauthorized');
  const callerUser = await verifySupabaseToken(callerToken);
  if (!callerUser || !callerUser.id) return fail(401, 'Invalid or expired session');

  if (action === 'deleteself') {
    const delRes = await supaAuthAdminRequest('DELETE', 'users/' + callerUser.id, serviceKey);
    await logSecurityEvent(serviceKey, callerUser.id, 'account_deleted_self', { status: delRes.status });
    if (delRes.status >= 200 && delRes.status < 300) return jsonResponse(200, { ok: true });
    return fail(500, 'Delete failed');
  }

  if (typeof action !== 'string' || !['status', 'search', 'setplan', 'reports', 'resolvereport', 'signups', 'subscriptions', 'retention', 'financials', 'getcostconfig', 'savecostconfig'].includes(action)) {
    return fail(400, 'Unknown action');
  }

  const adminCheck = await checkAdmin(callerUser, serviceKey);
  if (!adminCheck.ok) {
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_access_denied', { action });
    return fail(403, 'Unauthorized');
  }

  if (action === 'status') {
    return jsonResponse(200, { ok: true, isAdmin: true, method: adminCheck.method });
  }

  if (action === 'search') {
    if (query.length < 2) return fail(400, 'Search query must be at least 2 characters');
    const lowerQuery = query.toLowerCase();
    const matchedUsers: SupabaseUser[] = [];
    const PER_PAGE = 50;
    let page = 1;
    while (matchedUsers.length < 10) {
      const searchRes = await supaAuthAdminRequest<UsersListResponse>(
        'GET', 'users?per_page=' + PER_PAGE + '&page=' + page, serviceKey
      );
      if (searchRes.status < 200 || searchRes.status >= 300) return fail(500, 'User search failed');
      const pageUsers = (searchRes.body && searchRes.body.users) || [];
      pageUsers.forEach((u) => {
        const email = (u.email as string | undefined) || '';
        if (email.toLowerCase().includes(lowerQuery)) matchedUsers.push(u);
      });
      if (pageUsers.length < PER_PAGE) break;
      page++;
      if (page > 20) break;
    }

    const results: Array<{ id: string; email?: string; created_at?: string; plan: string; status: string }> = [];
    for (const u of matchedUsers.slice(0, 10)) {
      const subRes = await supaRequest<SubscriptionLite[]>(
        'GET',
        'subscriptions?user_id=eq.' + encodeURIComponent(u.id) + '&select=plan,status',
        null, serviceKey
      );
      const sub = Array.isArray(subRes.body) && subRes.body[0]
        ? subRes.body[0] : { plan: 'free', status: 'none' };
      results.push({
        id: u.id,
        email: u.email,
        created_at: u['created_at'] as string | undefined,
        plan: sub.plan || 'free',
        status: sub.status || 'none'
      });
    }

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_user_search', {
      query_length: query.length, result_count: results.length, auth_method: adminCheck.method
    });
    return jsonResponse(200, results);
  }

  if (action === 'setplan') {
    const allowedPlans = ['free', 'pro'];
    if (typeof plan !== 'string' || !allowedPlans.includes(plan)) return fail(400, 'Invalid plan');
    if (typeof userId !== 'string' || !isUuid(userId)) return fail(400, 'Invalid userId');

    const beforeRes = await supaRequest<SubscriptionLite[]>(
      'GET',
      'subscriptions?user_id=eq.' + encodeURIComponent(userId) + '&select=plan,status&limit=1',
      null, serviceKey
    );
    const before = Array.isArray(beforeRes.body) && beforeRes.body[0] ? beforeRes.body[0] : null;
    const newStatus = plan === 'pro' ? 'active' : 'cancelled';

    const upsertRes = await supaRequest('POST', 'subscriptions?on_conflict=user_id',
      {
        id: userId, user_id: userId, plan, status: newStatus,
        updated_at: new Date().toISOString()
      },
      serviceKey, { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
    if (upsertRes.status < 200 || upsertRes.status >= 300) return fail(500, 'Plan update failed');

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_set_subscription_plan', {
      target_user_id: userId,
      old_plan: before ? before.plan : null,
      old_status: before ? before.status : null,
      new_plan: plan, new_status: newStatus, auth_method: adminCheck.method
    });
    return jsonResponse(200, { ok: true });
  }

  if (action === 'reports') {
    const allowedStatuses = ['open', 'reviewed', 'dismissed', 'resolved'];
    const reportStatus = typeof status === 'string' && allowedStatuses.includes(status) ? status : 'open';
    const reportRes = await supaRequest<unknown[]>(
      'GET',
      'chat_reports?status=eq.' + encodeURIComponent(reportStatus) +
        '&select=id,reporter_id,reported_user_id,message_id,room_id,reason,details,status,created_at,reviewed_by,reviewed_at,resolution_note&order=created_at.desc&limit=50',
      null, serviceKey
    );
    if (reportRes.status < 200 || reportRes.status >= 300) return fail(500, 'Could not load reports');
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_reports_view', {
      status: reportStatus, auth_method: adminCheck.method
    });
    return jsonResponse(200, { reports: Array.isArray(reportRes.body) ? reportRes.body : [] });
  }

  if (action === 'resolvereport') {
    const allowedStatuses = ['reviewed', 'dismissed', 'resolved'];
    if (typeof reportId !== 'string' || !isUuid(reportId)) return fail(400, 'Invalid reportId');
    if (typeof status !== 'string' || !allowedStatuses.includes(status)) return fail(400, 'Invalid report status');
    if (resolutionNote.length > 1000) return fail(400, 'Resolution note is too long');

    const patchRes = await supaRequest('PATCH',
      'chat_reports?id=eq.' + encodeURIComponent(reportId),
      {
        status, reviewed_by: callerUser.id,
        reviewed_at: new Date().toISOString(),
        resolution_note: resolutionNote || null
      },
      serviceKey, { Prefer: 'return=minimal' }
    );
    if (patchRes.status < 200 || patchRes.status >= 300) return fail(500, 'Could not update report');

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_report_resolved', {
      report_id: reportId, status, auth_method: adminCheck.method
    });
    return jsonResponse(200, { ok: true });
  }

  // ── Analytics: signup growth ──────────────────────────────────────────────
  if (action === 'signups') {
    const r: Range = isRange(range) ? range : '30d';
    const b: Bucket = isBucket(bucket) ? bucket : defaultBucket(r);
    const timestamps = await collectSignupTimestamps(serviceKey);
    const result = bucketSignups(timestamps, r, b);
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_signups', {
      range: r, bucket: b, total_users: result.summary.total, auth_method: adminCheck.method
    });
    return jsonResponse(200, { ...result, metadata: { generatedAt: new Date().toISOString(), windowDays: RANGE_DAYS[r] } });
  }

  // ── Analytics: subscription snapshot ──────────────────────────────────────
  if (action === 'subscriptions') {
    const subRes = await supaRequest<SubRow[]>(
      'GET', 'subscriptions?select=plan,status,had_trial', null, serviceKey
    );
    const rows = Array.isArray(subRes.body) ? subRes.body : [];
    const summary = summarizeSubscriptions(rows);
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_subscriptions', {
      total_subs: summary.totalSubs, auth_method: adminCheck.method
    });
    return jsonResponse(200, { ...summary, metadata: { generatedAt: new Date().toISOString() } });
  }

  // ── Analytics: monthly retention (from subscription_events history) ───────
  if (action === 'retention') {
    let m = typeof months === 'number' ? Math.floor(months) : parseInt(String(months || ''), 10);
    if (!Number.isFinite(m) || m < 1) m = 12;
    if (m > 36) m = 36;
    // Only need events from the window under review. Pull a generous slice.
    const sinceMs = Date.now() - (m + 1) * 31 * 24 * 60 * 60 * 1000;
    const since = new Date(sinceMs).toISOString();
    const evRes = await supaRequest<SubEvent[]>(
      'GET',
      'subscription_events?created_at=gte.' + encodeURIComponent(since) +
        '&select=user_id,event_type,created_at&order=created_at.asc&limit=100000',
      null, serviceKey
    );
    // If the table doesn't exist yet (migration not applied) PostgREST returns
    // a non-array error body — degrade to an empty series rather than 500.
    const events = Array.isArray(evRes.body) ? evRes.body : [];
    const series = computeRetention(events, m);
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_retention', {
      months: m, event_count: events.length, auth_method: adminCheck.method
    });
    return jsonResponse(200, {
      series, months: m,
      available: Array.isArray(evRes.body),
      metadata: { generatedAt: new Date().toISOString() }
    });
  }

  // ── Financial: editable cost config (get / save) ──────────────────────────
  if (action === 'getcostconfig') {
    return jsonResponse(200, { config: await loadCostConfig(serviceKey) });
  }

  if (action === 'savecostconfig') {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return fail(400, 'Invalid config');
    const c = config as Record<string, unknown>;
    const num = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const row = {
      id: 1,
      monthly_price_cents: num(c.monthlyPriceCents),
      payment_fee_pct: num(c.paymentFeePct),
      payment_fee_fixed_cents: num(c.paymentFeeFixedCents),
      ai_interactive_cost_cents: num(c.aiInteractiveCostCents),
      ai_generation_cost_cents: num(c.aiGenerationCostCents),
      supabase_cost_cents: num(c.supabaseCostCents),
      hosting_cost_cents: num(c.hostingCostCents),
      other_cost_cents: num(c.otherCostCents),
      updated_at: new Date().toISOString()
    };
    if (Object.values(row).some((v) => v === null)) return fail(400, 'All cost fields must be non-negative numbers');
    const saveRes = await supaRequest('POST', 'admin_financial_config?on_conflict=id', row,
      serviceKey, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (saveRes.status < 200 || saveRes.status >= 300) return fail(500, 'Could not save cost config');
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_save_cost_config', { auth_method: adminCheck.method });
    return jsonResponse(200, { ok: true, config: await loadCostConfig(serviceKey) });
  }

  // ── Financial: revenue / cost / profit overview ───────────────────────────
  if (action === 'financials') {
    const cfg = await loadCostConfig(serviceKey);

    // Paid users (pro + active) from the subscriptions table.
    const subRes = await supaRequest<Array<{ user_id?: string; plan?: string; status?: string }>>(
      'GET', 'subscriptions?select=user_id,plan,status', null, serviceKey
    );
    const subRows = Array.isArray(subRes.body) ? subRes.body : [];
    const paidSet = new Set<string>();
    for (const r of subRows) {
      if (r.user_id && String(r.plan).toLowerCase() === 'pro' && String(r.status).toLowerCase() === 'active') {
        paidSet.add(String(r.user_id));
      }
    }

    // This month's AI usage from security_events.
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const INTERACTIVE_TYPES = ['ai_ask', 'ai_chat', 'writing_coach_analyse', 'ask_stream'];
    const GENERATION_TYPES = ['ai_generate', 'notes_generate'];
    const allTypes = [...INTERACTIVE_TYPES, ...GENERATION_TYPES].map(encodeURIComponent).join(',');
    const evRes = await supaRequest<Array<{ user_id?: string; event_type?: string }>>(
      'GET',
      'security_events?event_type=in.(' + allTypes + ')&created_at=gte.' + encodeURIComponent(since) +
        '&select=user_id,event_type&limit=200000',
      null, serviceKey
    );
    const evRows = Array.isArray(evRes.body) ? evRes.body : [];

    const usageMap = new Map<string, { interactive: number; generation: number }>();
    for (const e of evRows) {
      const uid = e.user_id ? String(e.user_id) : '';
      if (!uid) continue;
      const u = usageMap.get(uid) || { interactive: 0, generation: 0 };
      if (GENERATION_TYPES.includes(String(e.event_type))) u.generation++;
      else u.interactive++;
      usageMap.set(uid, u);
    }

    // Union of paid users and users with usage.
    const userIds = new Set<string>([...paidSet, ...usageMap.keys()]);
    const users: UserUsage[] = Array.from(userIds).map((uid) => {
      const u = usageMap.get(uid) || { interactive: 0, generation: 0 };
      return { userId: uid, interactive: u.interactive, generation: u.generation, paid: paidSet.has(uid) };
    });

    const result = computeFinancials(users, cfg);

    // Attach emails for the (bounded) danger-user list only.
    for (const d of result.dangerUsers) {
      try {
        const uRes = await supaAuthAdminRequest<{ email?: string }>('GET', 'users/' + d.userId, serviceKey);
        if (uRes.status >= 200 && uRes.status < 300 && uRes.body && uRes.body.email) d.email = uRes.body.email;
      } catch { /* best-effort */ }
    }

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_financials', {
      active_paid: result.activePaid, auth_method: adminCheck.method
    });
    return jsonResponse(200, { ...result, metadata: { generatedAt: new Date().toISOString() } });
  }

  return fail(400, 'Unknown action');
};

// Loads the singleton cost-config row, mapping snake_case → CostConfig and
// falling back to sensible defaults if the table/row isn't present yet.
async function loadCostConfig(serviceKey: string): Promise<CostConfig> {
  const defaults: CostConfig = {
    monthlyPriceCents: 1199,
    paymentFeePct: 2.9,
    paymentFeeFixedCents: 35,
    aiInteractiveCostCents: 0.1,
    aiGenerationCostCents: 0.5,
    supabaseCostCents: 2500,
    hostingCostCents: 500,
    otherCostCents: 0
  };
  try {
    const res = await supaRequest<Array<Record<string, unknown>>>(
      'GET', 'admin_financial_config?id=eq.1&select=*&limit=1', null, serviceKey
    );
    const row = Array.isArray(res.body) && res.body[0] ? res.body[0] : null;
    if (!row) return defaults;
    const n = (v: unknown, d: number): number => {
      const x = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(x) ? x : d;
    };
    return {
      monthlyPriceCents: n(row.monthly_price_cents, defaults.monthlyPriceCents),
      paymentFeePct: n(row.payment_fee_pct, defaults.paymentFeePct),
      paymentFeeFixedCents: n(row.payment_fee_fixed_cents, defaults.paymentFeeFixedCents),
      aiInteractiveCostCents: n(row.ai_interactive_cost_cents, defaults.aiInteractiveCostCents),
      aiGenerationCostCents: n(row.ai_generation_cost_cents, defaults.aiGenerationCostCents),
      supabaseCostCents: n(row.supabase_cost_cents, defaults.supabaseCostCents),
      hostingCostCents: n(row.hosting_cost_cents, defaults.hostingCostCents),
      otherCostCents: n(row.other_cost_cents, defaults.otherCostCents)
    };
  } catch {
    return defaults;
  }
}

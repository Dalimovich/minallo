import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { supaRequest, supaAuthAdminRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { logSecurityEvent } from '../lib/logger';
import { isUuid } from '../lib/validation';
import {
  bucketSignups, selectNewUsers, summarizeSubscriptions, computeRetention, computeFinancials, computeUsage,
  buildMonthList, bucketAiByMonth, computeFinanceSeries, computeAiUsage, computeUsageExport,
  isBucket, isRange, RANGE_DAYS, type Bucket, type Range, type SubRow, type SubEvent,
  type CostConfig, type UserUsage, type UsageEvent, type UsageEventRow
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

// Build a userId → email map by paging the Auth Admin API. Needs no migration
// and is fine at launch scale (same scan the signups/newusers actions use).
async function collectUserEmails(serviceKey: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const PER_PAGE = 1000;
  for (let page = 1; page <= 100; page++) {
    const res = await supaAuthAdminRequest<{ users?: Array<{ id?: string; email?: string }> }>(
      'GET', 'users?per_page=' + PER_PAGE + '&page=' + page, serviceKey
    );
    if (res.status < 200 || res.status >= 300) break;
    const users = (res.body && res.body.users) || [];
    for (const u of users) if (u.id && u.email) map.set(u.id, u.email);
    if (users.length < PER_PAGE) break;
  }
  return map;
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
      range: unknown, bucket: unknown, months: unknown, config: unknown, days: unknown;
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
    days = b.days;
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

  if (typeof action !== 'string' || !['status', 'search', 'setplan', 'reports', 'resolvereport', 'signups', 'newusers', 'subscriptions', 'retention', 'financials', 'financeseries', 'getcostconfig', 'savecostconfig', 'usage', 'aiusage', 'usageexport'].includes(action)) {
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

  // ── Analytics: users who signed up in the last 24 hours ───────────────────
  if (action === 'newusers') {
    const HOURS = 24;
    // Same paged auth-users scan as the signups action — needs no migration
    // and is fine at launch scale.
    const all: Array<{ id: string; email?: string; created_at?: string }> = [];
    const PER_PAGE = 1000;
    for (let page = 1; page <= 100; page++) {
      const res = await supaAuthAdminRequest<UsersListResponse>(
        'GET', 'users?per_page=' + PER_PAGE + '&page=' + page, serviceKey
      );
      if (res.status < 200 || res.status >= 300) break;
      const pageUsers = (res.body && res.body.users) || [];
      for (const u of pageUsers) {
        all.push({ id: u.id, email: u.email, created_at: u['created_at'] as string | undefined });
      }
      if (pageUsers.length < PER_PAGE) break;
    }
    const fresh = selectNewUsers(all, HOURS).slice(0, 50);

    // Plan/status for the fresh accounts in a single query.
    const planByUser = new Map<string, { plan: string; status: string }>();
    if (fresh.length) {
      const ids = fresh.map((u) => encodeURIComponent(u.id)).join(',');
      const subRes = await supaRequest<Array<{ user_id?: string; plan?: string; status?: string }>>(
        'GET', 'subscriptions?user_id=in.(' + ids + ')&select=user_id,plan,status', null, serviceKey
      );
      for (const r of (Array.isArray(subRes.body) ? subRes.body : [])) {
        if (r.user_id) planByUser.set(String(r.user_id), { plan: r.plan || 'free', status: r.status || 'none' });
      }
    }
    const users = fresh.map((u) => ({
      ...u,
      plan: planByUser.get(u.id)?.plan || 'free',
      status: planByUser.get(u.id)?.status || 'none'
    }));

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_new_users', {
      hours: HOURS, count: users.length, auth_method: adminCheck.method
    });
    return jsonResponse(200, { users, hours: HOURS, metadata: { generatedAt: new Date().toISOString() } });
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

  // ── Activity & feature usage (DAU/WAU/MAU + per-feature counts) ───────────
  if (action === 'usage') {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const AI_TYPES = ['ai_ask', 'ai_chat', 'writing_coach_analyse', 'ask_stream', 'ai_generate', 'notes_generate'];
    const typesParam = AI_TYPES.map(encodeURIComponent).join(',');
    const [aiRes, msgRes] = await Promise.all([
      supaRequest<Array<{ user_id?: string; event_type?: string; created_at?: string }>>(
        'GET',
        'security_events?event_type=in.(' + typesParam + ')&created_at=gte.' + encodeURIComponent(since) +
          '&select=user_id,event_type,created_at&limit=200000',
        null, serviceKey
      ),
      supaRequest<Array<{ user_id?: string; created_at?: string }>>(
        'GET',
        'messages?created_at=gte.' + encodeURIComponent(since) + '&select=user_id,created_at&limit=200000',
        null, serviceKey
      )
    ]);
    const aiRows = Array.isArray(aiRes.body) ? aiRes.body : [];
    const msgRows = Array.isArray(msgRes.body) ? msgRes.body : [];
    const events: UsageEvent[] = [
      ...aiRows.map((r) => ({ user_id: r.user_id, event_type: r.event_type, created_at: r.created_at })),
      ...msgRows.map((r) => ({ user_id: r.user_id, event_type: 'chat_message', created_at: r.created_at }))
    ];
    const result = computeUsage(events);
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_usage', {
      dau: result.dau, mau: result.mau, auth_method: adminCheck.method
    });
    return jsonResponse(200, { ...result, metadata: { generatedAt: new Date().toISOString() } });
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
      ai_input_cost_cents_per_m: num(c.aiInputCostCentsPerM),
      ai_output_cost_cents_per_m: num(c.aiOutputCostCentsPerM),
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
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const INTERACTIVE_TYPES = ['ai_ask', 'ai_chat', 'writing_coach_analyse', 'ask_stream'];
    const GENERATION_TYPES = ['ai_generate', 'notes_generate'];
    const allTypes = [...INTERACTIVE_TYPES, ...GENERATION_TYPES].map(encodeURIComponent).join(',');

    // This is the slowest dashboard card — fetch the four independent inputs
    // in one parallel wave instead of four sequential edge→DB round trips.
    const [cfg, subRes, evRes, meterRes] = await Promise.all([
      loadCostConfig(serviceKey),
      // Paid users (pro + active) from the subscriptions table.
      supaRequest<Array<{ user_id?: string; plan?: string; status?: string }>>(
        'GET', 'subscriptions?select=user_id,plan,status', null, serviceKey
      ),
      // This month's AI usage from security_events.
      supaRequest<Array<{ user_id?: string; event_type?: string }>>(
        'GET',
        'security_events?event_type=in.(' + allTypes + ')&created_at=gte.' + encodeURIComponent(since) +
          '&select=user_id,event_type&limit=200000',
        null, serviceKey
      ),
      // Cost source 1 (best): the usage_events meter — every OpenAI call, all
      // features, per-model pricing. Absent/empty (migration not applied yet,
      // or a window before the meter shipped) → degrade to source 2.
      supaRequest<UsageEventRow[]>(
        'GET',
        'usage_events?created_at=gte.' + encodeURIComponent(since) +
          '&select=user_id,feature,model,prompt_tokens,completion_tokens,cached_tokens&limit=300000',
        null, serviceKey
      )
    ]);

    const subRows = Array.isArray(subRes.body) ? subRes.body : [];
    const paidSet = new Set<string>();
    for (const r of subRows) {
      if (r.user_id && String(r.plan).toLowerCase() === 'pro' && String(r.status).toLowerCase() === 'active') {
        paidSet.add(String(r.user_id));
      }
    }

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

    const meterRows = Array.isArray(meterRes.body) ? meterRes.body : [];
    const meter = meterRows.length ? computeAiUsage(meterRows, cfg) : null;

    // Cost source 2: interactive (ask/stream) tokens from retrieval_debug_log.
    // Degrades further to per-call estimates if that table is empty too.
    const tokenMap = new Map<string, { prompt: number; completion: number }>();
    if (!meter) {
      const tokRes = await supaRequest<Array<{ user_id?: string; prompt_tokens?: number; completion_tokens?: number }>>(
        'GET',
        'retrieval_debug_log?created_at=gte.' + encodeURIComponent(since) +
          '&select=user_id,prompt_tokens,completion_tokens&limit=300000',
        null, serviceKey
      );
      const tokRows = Array.isArray(tokRes.body) ? tokRes.body : [];
      for (const t of tokRows) {
        const uid = t.user_id ? String(t.user_id) : '';
        if (!uid) continue;
        const e = tokenMap.get(uid) || { prompt: 0, completion: 0 };
        e.prompt += Number(t.prompt_tokens) || 0;
        e.completion += Number(t.completion_tokens) || 0;
        tokenMap.set(uid, e);
      }
    }

    // Union of paid users and users with usage.
    const userIds = new Set<string>([
      ...paidSet, ...usageMap.keys(), ...tokenMap.keys(),
      ...(meter ? meter.perUserCostCents.keys() : [])
    ]);
    const users: UserUsage[] = Array.from(userIds).map((uid) => {
      const u = usageMap.get(uid) || { interactive: 0, generation: 0 };
      const usr: UserUsage = { userId: uid, interactive: u.interactive, generation: u.generation, paid: paidSet.has(uid) };
      if (meter) {
        usr.meteredCostCents = meter.perUserCostCents.get(uid) || 0;
        return usr;
      }
      const tok = tokenMap.get(uid);
      if (tok && (tok.prompt > 0 || tok.completion > 0)) {
        usr.interactiveTokenCostCents =
          (tok.prompt * cfg.aiInputCostCentsPerM + tok.completion * cfg.aiOutputCostCentsPerM) / 1_000_000;
      }
      return usr;
    });
    // Service-level spend with no request user (indexing OCR, embeddings…)
    // still must count toward total AI cost — carried by a synthetic row.
    if (meter && meter.unattributedCostCents > 0) {
      users.push({
        userId: '(service: indexing/embeddings)',
        interactive: 0, generation: 0, paid: false,
        meteredCostCents: meter.unattributedCostCents
      });
    }

    const result = computeFinancials(users, cfg);

    // Attach emails for the (bounded) danger-user list. Done in parallel — a
    // sequential loop here was the main source of the dashboard's open latency.
    await Promise.all(result.dangerUsers.map(async (d) => {
      try {
        const uRes = await supaAuthAdminRequest<{ email?: string }>('GET', 'users/' + d.userId, serviceKey);
        if (uRes.status >= 200 && uRes.status < 300 && uRes.body && uRes.body.email) d.email = uRes.body.email;
      } catch { /* best-effort */ }
    }));

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_financials', {
      active_paid: result.activePaid, auth_method: adminCheck.method
    });
    return jsonResponse(200, {
      ...result,
      costSource: meter ? 'usage_events' : (tokenMap.size ? 'retrieval_debug_log' : 'estimates'),
      metadata: { generatedAt: new Date().toISOString() }
    });
  }

  // ── Financial: AI usage meter breakdown (per feature × model) ─────────────
  if (action === 'aiusage') {
    let d = typeof days === 'number' ? Math.floor(days) : parseInt(String(days || ''), 10);
    if (!Number.isFinite(d) || d < 1) d = 30;
    if (d > 365) d = 365;
    const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
    const [cfg, res] = await Promise.all([
      loadCostConfig(serviceKey),
      supaRequest<UsageEventRow[]>(
        'GET',
        'usage_events?created_at=gte.' + encodeURIComponent(since) +
          '&select=user_id,feature,model,prompt_tokens,completion_tokens,cached_tokens&limit=300000',
        null, serviceKey
      )
    ]);
    // Table missing (migration not applied) → tell the UI instead of 500ing.
    if (!Array.isArray(res.body)) {
      return jsonResponse(200, {
        available: false, days: d, lines: [], topUsers: [],
        totalCostCents: 0, totalRequests: 0, unattributedCostCents: 0,
        metadata: { generatedAt: new Date().toISOString() }
      });
    }
    const usage = computeAiUsage(res.body, cfg);
    const topUsers = Array.from(usage.perUserCostCents.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, costCents]) => ({ userId, costCents: Math.round(costCents * 100) / 100, email: undefined as string | undefined }));
    await Promise.all(topUsers.map(async (t) => {
      try {
        const uRes = await supaAuthAdminRequest<{ email?: string }>('GET', 'users/' + t.userId, serviceKey);
        if (uRes.status >= 200 && uRes.status < 300 && uRes.body && uRes.body.email) t.email = uRes.body.email;
      } catch { /* best-effort */ }
    }));
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_aiusage', {
      days: d, rows: res.body.length, auth_method: adminCheck.method
    });
    return jsonResponse(200, {
      available: true,
      days: d,
      lines: usage.lines,
      totalCostCents: usage.totalCostCents,
      totalRequests: usage.totalRequests,
      unattributedCostCents: usage.unattributedCostCents,
      topUsers,
      metadata: { generatedAt: new Date().toISOString() }
    });
  }

  // ── Financial: per-user cost/revenue/profit export (downloadable report) ──
  if (action === 'usageexport') {
    let d = typeof days === 'number' ? Math.floor(days) : parseInt(String(days || ''), 10);
    if (!Number.isFinite(d) || d < 1) d = 30;
    if (d > 365) d = 365;
    const sinceDate = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    const since = sinceDate.toISOString();
    const [cfg, meterRes, subRes, emailMap] = await Promise.all([
      loadCostConfig(serviceKey),
      supaRequest<UsageEventRow[]>(
        'GET',
        'usage_events?created_at=gte.' + encodeURIComponent(since) +
          '&select=user_id,feature,model,prompt_tokens,completion_tokens,cached_tokens&limit=500000',
        null, serviceKey
      ),
      supaRequest<Array<{ user_id?: string; plan?: string; status?: string }>>(
        'GET', 'subscriptions?select=user_id,plan,status', null, serviceKey
      ),
      collectUserEmails(serviceKey)
    ]);
    // Table missing (migration not applied) → tell the UI instead of 500ing.
    if (!Array.isArray(meterRes.body)) {
      return jsonResponse(200, {
        available: false, days: d, rows: [],
        metadata: { generatedAt: new Date().toISOString() }
      });
    }
    const subRows = Array.isArray(subRes.body) ? subRes.body : [];
    const paidSet = new Set<string>();
    for (const r of subRows) {
      if (r.user_id && String(r.plan).toLowerCase() === 'pro' && String(r.status).toLowerCase() === 'active') {
        paidSet.add(String(r.user_id));
      }
    }
    const rows = computeUsageExport(meterRes.body, paidSet, cfg).map((row) => ({
      ...row,
      email: emailMap.get(row.userId) || row.email
    }));
    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_usage_export', {
      days: d, rows: rows.length, auth_method: adminCheck.method
    });
    return jsonResponse(200, {
      available: true,
      days: d,
      since,
      generatedAt: new Date().toISOString(),
      rows,
      metadata: { generatedAt: new Date().toISOString() }
    });
  }

  // ── Financial: monthly revenue / cost / profit trend ──────────────────────
  if (action === 'financeseries') {
    let m = typeof months === 'number' ? Math.floor(months) : parseInt(String(months || ''), 10);
    if (!Number.isFinite(m) || m < 1) m = 6;
    if (m > 24) m = 24;
    const monthsList = buildMonthList(m);
    const currentMonth = monthsList[monthsList.length - 1];
    const sinceMonthStart = monthsList[0] + '-01T00:00:00.000Z';

    // Active paid per month from subscription_events history (if available).
    const retSinceMs = Date.now() - (m + 1) * 31 * 24 * 60 * 60 * 1000;
    const [cfg, evRetRes, aiRes, subRes] = await Promise.all([
      loadCostConfig(serviceKey),
      supaRequest<SubEvent[]>(
        'GET',
        'subscription_events?created_at=gte.' + encodeURIComponent(new Date(retSinceMs).toISOString()) +
          '&select=user_id,event_type,created_at&order=created_at.asc&limit=100000',
        null, serviceKey
      ),
      supaRequest<Array<{ event_type?: string; created_at?: string }>>(
        'GET',
        'security_events?event_type=in.(' +
          ['ai_ask', 'ai_chat', 'writing_coach_analyse', 'ask_stream', 'ai_generate', 'notes_generate']
            .map(encodeURIComponent).join(',') +
          ')&created_at=gte.' + encodeURIComponent(sinceMonthStart) +
          '&select=event_type,created_at&limit=300000',
        null, serviceKey
      ),
      supaRequest<Array<{ plan?: string; status?: string }>>(
        'GET', 'subscriptions?select=plan,status', null, serviceKey
      )
    ]);

    const retEvents = Array.isArray(evRetRes.body) ? evRetRes.body : [];
    const retentionAvailable = Array.isArray(evRetRes.body);
    const retention = computeRetention(retEvents, m);
    const activeByMonth: Record<string, number> = {};
    for (const r of retention) activeByMonth[r.month] = r.active;

    // The current month's active-paid count is authoritative from the live
    // subscriptions table (covers the no-events / no-migration case too).
    const subRows = Array.isArray(subRes.body) ? subRes.body : [];
    const liveActivePaid = subRows.filter(
      (r) => String(r.plan).toLowerCase() === 'pro' && String(r.status).toLowerCase() === 'active'
    ).length;
    if (currentMonth) {
      activeByMonth[currentMonth] = Math.max(activeByMonth[currentMonth] || 0, liveActivePaid);
    }

    const aiRows = Array.isArray(aiRes.body) ? aiRes.body : [];
    const aiByMonth = bucketAiByMonth(
      aiRows.map((r) => ({ event_type: r.event_type, created_at: r.created_at }))
    );

    const series = computeFinanceSeries(monthsList, activeByMonth, aiByMonth, cfg);
    const dataMonths = series.filter((p) => p.activePaid > 0 || p.aiCalls > 0).length;

    await logSecurityEvent(serviceKey, callerUser.id, 'admin_stats_finance_series', {
      months: m, data_months: dataMonths, auth_method: adminCheck.method
    });
    return jsonResponse(200, {
      series, months: m, dataMonths,
      retentionAvailable,
      metadata: { generatedAt: new Date().toISOString() }
    });
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
    aiInputCostCentsPerM: 300,   // ≈ $3 per 1M input tokens (Claude Sonnet)
    aiOutputCostCentsPerM: 1500, // ≈ $15 per 1M output tokens
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
      aiInputCostCentsPerM: n(row.ai_input_cost_cents_per_m, defaults.aiInputCostCentsPerM),
      aiOutputCostCentsPerM: n(row.ai_output_cost_cents_per_m, defaults.aiOutputCostCentsPerM),
      supabaseCostCents: n(row.supabase_cost_cents, defaults.supabaseCostCents),
      hostingCostCents: n(row.hosting_cost_cents, defaults.hostingCostCents),
      otherCostCents: n(row.other_cost_cents, defaults.otherCostCents)
    };
  } catch {
    return defaults;
  }
}

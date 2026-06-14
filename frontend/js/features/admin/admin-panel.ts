import {
  checkAdminStatus,
  searchUsers,
  setUserPlan,
  reindexUserCourse,
  listRetrievalLogs,
  getRetrievalLog,
  type RetrievalLogLite,
  type RetrievalLogFull,
  type RetrievalChunkMeta,
  type SignupStats,
  type SubscriptionStats,
  type RetentionStats,
  type FinancialStats,
  type DangerUser,
  type CostConfig,
  type UsageStats,
  type UsageExport,
} from '../../services/admin-service.js';
// Analytics functions are reached via a namespace import on purpose: this
// module is lazy-imported when the admin page opens, and a stale browser-cached
// admin-service.js (missing these newer exports) would otherwise fail to LINK
// the whole admin module and stop the page from opening at all. With a
// namespace import a missing export is just `undefined`, so the dashboard
// degrades to absent while the rest of the admin page still works.
import * as adminSvc from '../../services/admin-service.js';
import type { FinanceSeries, NewUser } from '../../services/admin-service.js';
import { renderBarChart, renderLineChart, type LinePoint } from './admin-charts.js';
import { escapeHtml } from '../../utils/escape-html.js';

interface AdminUser {
  id: string;
  email?: string;
  plan?: string;
  status?: string;
  created_at?: string;
}

export function adminShowIfEligible(user: { id?: string } | null): void {
  const btn = document.getElementById('psbAdmin');
  if (!btn || !user) return;
  btn.style.display = 'none';
  checkAdminStatus()
    .then((data) => {
      const isAdmin = !!(data && typeof data === 'object' && 'isAdmin' in data && (data as { isAdmin?: boolean }).isAdmin);
      if (isAdmin) btn.style.display = '';
    })
    .catch(() => {});
}

export function initAdminPanel(): void {
  const searchBtn = document.getElementById('adminSearchBtn');
  const searchInput = document.getElementById('adminSearchInput') as HTMLInputElement | null;

  // Navigation (show section, set nav-active, push #portal=admin) is wired in
  // router.js alongside every other sidebar button, so it works on the first
  // click rather than waiting for this lazily-loaded module. Here we only wire
  // the admin feature itself: search, retrieval inspector, and stats.
  if (searchBtn) searchBtn.addEventListener('click', adminSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') adminSearch();
    });
  }
  initRetrievalInspector();
  initAdminStats();
  initUsageExport();
}

// ── Per-user cost/revenue/profit export (downloadable Excel/CSV report) ───────

function initUsageExport(): void {
  const btn = document.getElementById('adminExportBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => { void downloadUsageReport(btn); });
}

// Quote a CSV cell, escaping embedded quotes and forcing text/number handling.
function _csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function _eurNum(cents: number, dp = 2): string {
  return (cents / 100).toFixed(dp);
}

function _buildUsageCsv(data: UsageExport): string {
  const header = [
    'Email', 'User ID', 'Plan', 'Requests',
    'Input tokens', 'Cached tokens', 'Output tokens',
    'AI cost (€)', 'Revenue (€)', 'Payment fees (€)', 'Profit (€)',
  ];
  const lines: string[] = [header.map(_csvCell).join(',')];
  const totals = { requests: 0, prompt: 0, cached: 0, completion: 0, ai: 0, rev: 0, fee: 0, profit: 0 };
  for (const r of data.rows) {
    totals.requests += r.requests;
    totals.prompt += r.promptTokens;
    totals.cached += r.cachedTokens;
    totals.completion += r.completionTokens;
    totals.ai += r.aiCostCents;
    totals.rev += r.revenueCents;
    totals.fee += r.feeCents;
    totals.profit += r.profitCents;
    lines.push([
      r.email || '', r.userId, r.paid ? 'Pro' : 'Free', r.requests,
      r.promptTokens, r.cachedTokens, r.completionTokens,
      _eurNum(r.aiCostCents, 4), _eurNum(r.revenueCents), _eurNum(r.feeCents), _eurNum(r.profitCents),
    ].map(_csvCell).join(','));
  }
  lines.push([
    'TOTAL', '', '', totals.requests,
    totals.prompt, totals.cached, totals.completion,
    _eurNum(totals.ai, 4), _eurNum(totals.rev), _eurNum(totals.fee), _eurNum(totals.profit),
  ].map(_csvCell).join(','));
  return lines.join('\r\n');
}

async function downloadUsageReport(btn: HTMLButtonElement): Promise<void> {
  const sel = document.getElementById('adminExportPeriod') as HTMLSelectElement | null;
  const status = document.getElementById('adminExportStatus');
  const days = parseInt(sel?.value || '30', 10) || 30;
  if (typeof adminSvc.getUsageExport !== 'function') {
    if (status) status.innerHTML = '<div class="adm-empty">Export unavailable — reload the page to pick up the latest admin code.</div>';
    return;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Building…';
  if (status) status.innerHTML = '<div class="adm-empty">Generating report…</div>';
  try {
    const data = await adminSvc.getUsageExport(days);
    if (!data) throw new Error('Request failed');
    if (!data.available) {
      if (status) status.innerHTML = '<div class="adm-empty">No meter data. Apply the <code>20260612_000001_usage_events</code> migration first.</div>';
      return;
    }
    const csv = _buildUsageCsv(data);
    // UTF-8 BOM so Excel opens accented emails / the € sign correctly.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'minallo-report-last-' + days + 'd-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (status) {
      status.innerHTML = '<div class="adm-empty">Downloaded ' + data.rows.length +
        ' user row(s) for the last ' + days + ' days.</div>';
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (status) status.innerHTML = '<div class="adm-empty">Export failed: ' + escapeHtml(msg) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ── Analytics dashboard ─────────────────────────────────────────────────────

let _statsLoaded = false;

// Big KPI card for the top strip (mirrors the preview's `.kpi`).
// `tone` tints the delta chip: 'ok' (green), 'warn' (yellow), 'loss' (red).
function _kpiCard(
  label: string,
  value: string | number,
  delta?: string,
  tone: 'ok' | 'warn' | 'loss' = 'ok',
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'adm-kpi' + (tone === 'warn' ? ' warn' : tone === 'loss' ? ' loss' : '');
  card.innerHTML =
    '<div class="adm-kpi-label">' + escapeHtml(label) + '</div>' +
    '<div class="adm-kpi-value">' + escapeHtml(String(value)) + '</div>' +
    (delta ? '<div class="adm-kpi-delta">' + escapeHtml(delta) + '</div>' : '');
  return card;
}

// Compact stat used inside cards (growth / activity / subscriptions).
function _miniCard(label: string, value: string | number, accent?: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'adm-mini';
  const b = document.createElement('b');
  if (accent) b.style.color = accent;
  b.textContent = String(value);
  const s = document.createElement('span');
  s.textContent = label;
  card.append(b, s);
  return card;
}

function _defaultBucketFor(range: string): 'day' | 'week' | 'month' {
  if (range === '365d' || range === 'all') return 'month';
  if (range === '90d') return 'week';
  return 'day';
}

function initAdminStats(): void {
  const root = document.getElementById('adminStats');
  if (!root) return;
  const navBtn = document.getElementById('psbAdmin');
  // Lazy-load on first time the admin section is opened.
  if (navBtn) navBtn.addEventListener('click', () => { void loadAdminStats(); });
  // If this module finished loading after the user already navigated to the
  // admin section (the nav handler lives in router.js and fires from boot),
  // the click above was missed — load now so the dashboard isn't left blank.
  const sec = document.getElementById('psec-admin');
  if (sec && sec.style.display !== 'none') void loadAdminStats();

  const rangeSel = document.getElementById('adminRangeSel') as HTMLSelectElement | null;
  const bucketSel = document.getElementById('adminBucketSel') as HTMLSelectElement | null;
  if (rangeSel) {
    rangeSel.addEventListener('change', () => {
      if (bucketSel) bucketSel.value = _defaultBucketFor(rangeSel.value);
      void reloadSignupChart();
    });
  }
  if (bucketSel) bucketSel.addEventListener('change', () => { void reloadSignupChart(); });
}

function _sectionLoading(id: string): void {
  const el = document.getElementById(id);
  if (el && !el.innerHTML) el.innerHTML = '<div class="adm-empty">Loading…</div>';
}

async function loadAdminStats(): Promise<void> {
  if (_statsLoaded) return;
  _statsLoaded = true;
  const loading = document.getElementById('adminStatsLoading');
  const body = document.getElementById('adminStatsBody');
  // Stale cached admin-service.js without the analytics exports → hide the
  // dashboard entirely rather than show a broken/loading-forever panel.
  if (typeof adminSvc.getSignupStats !== 'function') {
    const stats = document.getElementById('adminStats');
    if (stats) stats.style.display = 'none';
    return;
  }
  _initFinanceToggle();

  // Reveal the dashboard immediately with per-section "Loading…" placeholders,
  // then let each section fill in as its own request resolves. Previously we
  // awaited ALL requests before showing anything, so the whole page waited on
  // the slowest call (the financials endpoint). Now it feels instant.
  if (loading) loading.style.display = 'none';
  if (body) body.style.display = '';
  ['adminFinanceCards', 'adminFinanceChart', 'adminGrowthCards', 'adminDangerUsers',
   'adminActivityCards', 'adminSubCards', 'adminFunnel', 'adminRetention',
   'adminNewUsers', 'adminAiUsage'].forEach(_sectionLoading);

  // Fire independently; a slow/failed section never blocks the others.
  const guard = (p: Promise<void>): Promise<void> => p.catch(() => { /* section shows its own empty state */ });
  void guard(loadNewUsers());
  void guard(loadFinancials());
  void guard(loadUsage());
  void guard(loadAiUsage());
  document.getElementById('adminAiUsageDays')?.addEventListener('change', () => {
    _sectionLoading('adminAiUsage');
    void guard(loadAiUsage());
  });
  void guard(loadFinanceSeries());
  void guard(loadSubscriptionCards());
  void guard(loadRetention());
  // Funnel reuses the signup scan rather than running a second full one.
  void guard(reloadSignupChart().then(() => loadFunnel()));
}

async function reloadSignupChart(): Promise<void> {
  const rangeSel = document.getElementById('adminRangeSel') as HTMLSelectElement | null;
  const bucketSel = document.getElementById('adminBucketSel') as HTMLSelectElement | null;
  const range = rangeSel?.value || '30d';
  const bucket = bucketSel?.value || _defaultBucketFor(range);
  const data = adminSvc.getSignupStats ? await adminSvc.getSignupStats(range, bucket) : null;
  if (data) {
    // summary.total is the all-time user count regardless of range — reuse it
    // for the funnel so we don't trigger a second full auth-users scan.
    _lastSignupTotal = data.summary.total;
    _renderGrowthCards(data);
    _renderNewUserStats(data);
    _renderSignupChart(data);
  }
}

let _lastSignupTotal = 0;

// Subscription snapshot is needed by both the Subscriptions cards and the
// funnel — fetch it once per dashboard open and share the promise.
let _subStatsPromise: Promise<SubscriptionStats | null> | null = null;
function _getSubStats(): Promise<SubscriptionStats | null> {
  if (!_subStatsPromise) {
    _subStatsPromise = adminSvc.getSubscriptionStats ? adminSvc.getSubscriptionStats() : Promise.resolve(null);
  }
  return _subStatsPromise;
}

function _renderGrowthCards(data: SignupStats): void {
  const host = document.getElementById('adminGrowthCards');
  if (!host) return;
  host.innerHTML = '';
  const s = data.summary;
  host.appendChild(_miniCard('Today', s.today, '#7dd3fc'));
  host.appendChild(_miniCard('This week', s.week, '#7dd3fc'));
  host.appendChild(_miniCard('This month', s.month));
  host.appendChild(_miniCard('This year', s.year));
  host.appendChild(_miniCard('Total users', s.total, '#6ee7b7'));
  host.appendChild(_miniCard('Current (>7d)', s.currentUsers));
}

// ── New users (last 24h) ─────────────────────────────────────────────────────

// Daily / weekly / monthly signup counts inside the New-users card, fed from
// the signup scan that the growth chart already runs (no extra request).
function _renderNewUserStats(data: SignupStats): void {
  const host = document.getElementById('adminNewUserStats');
  if (!host) return;
  host.innerHTML = '';
  const s = data.summary;
  host.appendChild(_miniCard('Today', s.today, '#34d399'));
  host.appendChild(_miniCard('Last 7 days', s.week, '#7dd3fc'));
  host.appendChild(_miniCard('Last 30 days', s.month));
}

const NEW_USER_MS = 24 * 60 * 60 * 1000;

function _isNewUser(createdAt?: string): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && Date.now() - t < NEW_USER_MS;
}

function _newChip(): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'adm-new-chip';
  chip.textContent = 'NEW';
  return chip;
}

function _timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  return hrs + ' h ago';
}

async function loadNewUsers(): Promise<void> {
  const host = document.getElementById('adminNewUsers');
  if (!host) return;
  const data = typeof adminSvc.getNewUsers === 'function' ? await adminSvc.getNewUsers() : null;
  const badge = document.getElementById('adminNewUsersBadge');
  if (!data) {
    host.innerHTML = '<div class="adm-empty">New-user list unavailable.</div>';
    return;
  }
  const users = data.users || [];
  if (badge) {
    badge.style.display = users.length ? '' : 'none';
    badge.textContent = '+' + users.length;
  }
  if (!users.length) {
    host.innerHTML = '<div class="adm-empty">No new users in the last 24 hours.</div>';
    return;
  }
  host.innerHTML = '';
  users.forEach((u) => host.appendChild(_renderNewUserRow(u)));
}

function _renderNewUserRow(u: NewUser): HTMLElement {
  const row = document.createElement('div');
  row.className = 'adm-new-user';
  row.appendChild(_newChip());

  const info = document.createElement('div');
  info.className = 'adm-new-user-info';
  const email = document.createElement('b');
  email.textContent = u.email || u.id.slice(0, 8) + '…';
  const meta = document.createElement('span');
  const joined = u.created_at ? new Date(u.created_at).toLocaleString() : '';
  meta.textContent = joined + (u.created_at ? ' · ' + _timeAgo(u.created_at) : '');
  info.append(email, meta);
  row.appendChild(info);

  const isPro = u.plan === 'pro' && u.status === 'active';
  const plan = document.createElement('span');
  plan.className = 'adm-tag' + (isPro ? ' green' : '');
  plan.textContent = isPro ? 'Pro' : 'Free';
  row.appendChild(plan);
  return row;
}

function _renderSignupChart(data: SignupStats): void {
  const host = document.getElementById('adminSignupChart');
  if (!host) return;
  const series = data.series || [];
  if (!series.length) {
    host.innerHTML = '<div class="adm-empty">No signups in this range.</div>';
    return;
  }
  const max = series.reduce((m, p) => (p.count > m ? p.count : m), 0) || 1;
  // Compact the date label for readability (YYYY-MM-DD → DD/MM, YYYY-MM → MMM).
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = (d: string): string => {
    const p = d.split('-');
    if (p.length === 2) return months[Number(p[1]) - 1] || d;
    if (p.length === 3) return p[2] + '/' + p[1];
    return d;
  };
  const xTitle = data.bucket === 'month' ? 'Month' : data.bucket === 'week' ? 'Week' : 'Day';
  renderBarChart(
    host,
    series.map((p) => ({ label: label(p.date), value: p.count })),
    {
      tooltipNoun: 'signup',
      yTitle: 'New users',
      xTitle,
      caption: data.total + ' signups · ' + series[0]!.date + ' → ' + series[series.length - 1]!.date +
        ' · peak ' + max + '/' + data.bucket,
    },
  );
}

// ── Monthly revenue / cost / profit trend ────────────────────────────────────

let _financeSeries: FinanceSeries | null = null;
let _financeMode: 'money' | 'users' = 'money';

async function loadFinanceSeries(): Promise<void> {
  const host = document.getElementById('adminFinanceChart');
  if (!host) return;
  _financeSeries = adminSvc.getFinanceSeries ? await adminSvc.getFinanceSeries(6) : null;
  _renderFinanceSeries();
}

function _renderFinanceSeries(): void {
  const host = document.getElementById('adminFinanceChart');
  if (!host) return;
  const data = _financeSeries;
  if (!data || data.dataMonths < 2) {
    host.innerHTML =
      '<div class="adm-empty">Not enough history yet — the revenue / cost / profit trend appears once you have at least 2 months of activity. ' +
      'Current-month figures are in the KPIs and Profit breakdown above.</div>';
    return;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mLabel = (m: string): string => months[Number(m.split('-')[1]) - 1] || m;

  let points: LinePoint[];
  let fmt: (n: number) => string;
  let yTitle: string;
  if (_financeMode === 'money') {
    points = data.series.map((p) => ({
      label: mLabel(p.month),
      revenue: p.revenueCents / 100,
      cost: p.costCents / 100,
      profit: p.profitCents / 100,
    }));
    fmt = (n: number): string => {
      const a = Math.abs(n);
      if (a >= 1000) return '€' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return '€' + Math.round(n);
    };
    yTitle = 'Euros / month';
  } else {
    // "Users" view: paid users and AI-call volume share the profit/revenue lines.
    points = data.series.map((p) => ({
      label: mLabel(p.month),
      revenue: p.activePaid,
      cost: p.aiCalls,
      profit: p.activePaid,
    }));
    fmt = (n: number): string => String(Math.round(n));
    yTitle = 'Count / month';
  }
  renderLineChart(host, points, fmt, { yTitle, xTitle: 'Month' });
}

function _initFinanceToggle(): void {
  const seg = document.getElementById('adminFinanceToggle');
  if (!seg || seg.dataset['wired'] === '1') return;
  seg.dataset['wired'] = '1';
  seg.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-metric]') as HTMLElement | null;
    if (!btn) return;
    const mode = btn.dataset['metric'];
    if (mode !== 'money' && mode !== 'users') return;
    _financeMode = mode;
    seg.querySelectorAll('button[data-metric]').forEach((b) => b.classList.toggle('active', b === btn));
    _renderFinanceSeries();
  });
}

// ── Subscription funnel ──────────────────────────────────────────────────────

async function loadFunnel(): Promise<void> {
  const host = document.getElementById('adminFunnel');
  if (!host) return;
  // Reuse the shared subscription snapshot + the signup scan's total count
  // rather than issuing fresh requests.
  const subs = await _getSubStats();
  const totalUsers = _lastSignupTotal;
  const stages: Array<[string, number]> = [
    ['Signups', totalUsers],
    ['Trials', subs?.trialsStarted ?? 0],
    ['Converted', subs?.converted ?? 0],
    ['Active paid', subs?.activePaid ?? 0],
    ['Cancelled', subs?.cancelled ?? 0],
  ];
  const top = Math.max(totalUsers, 1);
  host.innerHTML = stages
    .map(([name, n]) => {
      const pct = Math.round((n / top) * 100);
      return (
        '<div class="adm-bar-row">' +
        '<span>' + name + '</span>' +
        '<div class="adm-track"><span style="width:' + (n > 0 ? Math.max(pct, 3) : 0) + '%"></span></div>' +
        '<b>' + n + '</b>' +
        '</div>'
      );
    })
    .join('');
}

async function loadSubscriptionCards(): Promise<void> {
  const host = document.getElementById('adminSubCards');
  if (!host) return;
  const data: SubscriptionStats | null = await _getSubStats();
  host.innerHTML = '';
  if (!data) {
    host.innerHTML = '<div class="adm-empty">Subscription stats unavailable.</div>';
    return;
  }
  host.appendChild(_miniCard('Trials started', data.trialsStarted, '#fbbf24'));
  host.appendChild(_miniCard('Converted', data.converted, '#6ee7b7'));
  host.appendChild(_miniCard('Conversion', data.conversionRate + '%', '#6ee7b7'));
  host.appendChild(_miniCard('Active paid', data.activePaid, '#7dd3fc'));
  host.appendChild(_miniCard('Trialing now', data.trialing));
  host.appendChild(_miniCard('Cancelled', data.cancelled, '#f87171'));
}

async function loadRetention(): Promise<void> {
  const host = document.getElementById('adminRetention');
  if (!host) return;
  const data: RetentionStats | null = adminSvc.getRetentionStats ? await adminSvc.getRetentionStats(12) : null;
  host.innerHTML = '';
  if (!data || !data.available) {
    host.innerHTML =
      '<div class="adm-empty">' +
      'No retention history yet. Apply the <code>subscription_events</code> migration; numbers fill in as Stripe/PayPal webhooks fire.' +
      '</div>';
    return;
  }
  const rows = data.series || [];
  const table = document.createElement('table');
  table.className = 'adm-table';
  table.innerHTML =
    '<thead><tr>' +
    ['Month', 'Active paid', 'New paid', 'Renewed', 'Cancelled'].map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cells = [r.month, String(r.active), String(r.newPaid), String(r.renewed), String(r.cancelled)];
    tr.innerHTML = cells
      .map((c, i) => '<td' + (i === 0 ? ' class="lead"' : '') + '>' + escapeHtml(c) + '</td>')
      .join('');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

// ── Financial overview ──────────────────────────────────────────────────────

function _eur(cents: number): string {
  return (cents / 100).toFixed(2) + ' €';
}

async function loadFinancials(): Promise<void> {
  const cards = document.getElementById('adminFinanceCards');
  if (!cards) return;
  const data: FinancialStats | null = adminSvc.getFinancials ? await adminSvc.getFinancials() : null;
  if (!data) {
    cards.innerHTML =
      '<div class="adm-empty">Financial data unavailable. Apply the <code>admin_financial_config</code> migration.</div>';
    return;
  }
  cards.innerHTML = '';
  const profitTone: 'ok' | 'loss' = data.netProfitCents >= 0 ? 'ok' : 'loss';
  const aiPctOfRevenue = data.revenueCents > 0 ? Math.round((data.aiCostCents / data.revenueCents) * 100) : 0;
  cards.appendChild(_kpiCard('MRR', _eur(data.mrrCents), '↗ ' + data.activePaid + ' paid users'));
  cards.appendChild(_kpiCard('Revenue this month', _eur(data.revenueCents)));
  cards.appendChild(_kpiCard('Net profit', _eur(data.netProfitCents), data.profitMargin + '% margin', profitTone));
  cards.appendChild(_kpiCard('AI API costs', _eur(data.aiCostCents), aiPctOfRevenue + '% of revenue', 'warn'));
  cards.appendChild(_kpiCard('Active paid', data.activePaid));
  cards.appendChild(_kpiCard('Profit / paid user', _eur(data.profitPerPaidUserCents), undefined, profitTone));

  // Make the scope explicit so an all-zero month reads as "no data yet"
  // rather than "broken". Figures are current calendar month to date.
  const now = new Date();
  const monthName = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  let caption = 'Current month (' + monthName + ') · revenue = active paid × price';
  if (data.activePaid === 0 && data.aiCostCents === 0) {
    caption = 'No active paid subscribers and no AI usage recorded yet this month (' + monthName + ').';
  }
  const cap = document.createElement('div');
  cap.className = 'adm-chart-cap';
  cap.style.cssText = 'grid-column:1/-1;margin-top:2px';
  cap.textContent = caption;
  cards.appendChild(cap);

  _renderFinanceBreakdown(data);
  _renderDangerUsers(data.dangerUsers);
  _renderCostConfig(data.config);
}

function _renderFinanceBreakdown(data: FinancialStats): void {
  const host = document.getElementById('adminFinanceBreakdown');
  if (!host) return;
  const profitClass = data.netProfitCents >= 0 ? 'good' : 'bad';
  const margin = Math.max(0, Math.min(100, data.profitMargin));
  host.innerHTML =
    '<div class="adm-money-box">' +
      '<div class="adm-money-row"><span>Subscription revenue</span><b class="good">' + _eur(data.revenueCents) + '</b></div>' +
      '<div class="adm-money-row"><span>AI API costs</span><b class="bad">-' + _eur(data.aiCostCents) + '</b></div>' +
      '<div class="adm-money-row"><span>Payment fees</span><b class="bad">-' + _eur(data.paymentFeesCents) + '</b></div>' +
      '<div class="adm-money-row"><span>Fixed costs (Supabase / hosting / other)</span><b class="bad">-' + _eur(data.fixedCostsCents) + '</b></div>' +
      '<div class="adm-money-row result"><span>Net profit</span><b class="' + profitClass + '">' + _eur(data.netProfitCents) + '</b></div>' +
    '</div>' +
    '<div class="adm-meter-label"><span>Profit margin</span><span>' + data.profitMargin + '%</span></div>' +
    '<div class="adm-meter"><span style="width:' + margin + '%"></span></div>' +
    '<div class="adm-note">' +
      data.interactiveCalls + ' interactive + ' + data.generationCalls + ' generation AI calls this month' +
      (data.measuredAiCostCents > 0
        ? ' · AI cost = ' + _eur(data.measuredAiCostCents) + ' measured (real tokens) + ' +
          _eur(data.estimatedAiCostCents) + ' estimated'
        : ' · AI cost estimated (no token data yet)') +
    '</div>';
}

// ── AI usage meter (usage_events breakdown) ─────────────────────────────────

function _tok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

async function loadAiUsage(): Promise<void> {
  const host = document.getElementById('adminAiUsage');
  if (!host) return;
  const daysSel = document.getElementById('adminAiUsageDays') as HTMLSelectElement | null;
  const days = parseInt(daysSel?.value || '30', 10) || 30;
  const data = adminSvc.getAiUsage ? await adminSvc.getAiUsage(days) : null;
  if (!data) {
    host.innerHTML = '<div class="adm-empty">AI usage unavailable (stale admin service or request failed).</div>';
    return;
  }
  if (!data.available) {
    host.innerHTML =
      '<div class="adm-empty">No meter data. Apply the <code>20260612_000001_usage_events</code> migration ' +
      'in the Supabase SQL editor — the backend is already reporting.</div>';
    return;
  }
  if (!data.lines.length) {
    host.innerHTML = '<div class="adm-empty">No AI calls recorded in the last ' + days + ' days.</div>';
    return;
  }
  const rows = data.lines.map((l) => {
    const cachedPct = l.promptTokens > 0 ? Math.round((l.cachedTokens / l.promptTokens) * 100) : 0;
    return (
      '<tr>' +
      '<td class="lead">' + escapeHtml(l.feature) + '</td>' +
      '<td>' + escapeHtml(l.model) + '</td>' +
      '<td>' + String(l.requests) + '</td>' +
      '<td>' + _tok(l.promptTokens) + (cachedPct > 0 ? ' <span class="adm-tag green">' + cachedPct + '% cached</span>' : '') + '</td>' +
      '<td>' + _tok(l.completionTokens) + '</td>' +
      '<td style="font-weight:700">' + (l.costCents / 100).toFixed(3) + ' €</td>' +
      '</tr>'
    );
  }).join('');
  const top = data.topUsers
    .filter((t) => t.costCents > 0)
    .slice(0, 5)
    .map((t) => escapeHtml(t.email || t.userId.slice(0, 8) + '…') + ' (' + (t.costCents / 100).toFixed(2) + ' €)')
    .join(' · ');
  host.innerHTML =
    '<div class="adm-mini-grid" style="margin-bottom:12px">' +
      _kpiCard('Total AI spend', (data.totalCostCents / 100).toFixed(2) + ' €', 'last ' + data.days + ' days', 'warn').outerHTML +
      _kpiCard('OpenAI requests', data.totalRequests).outerHTML +
      _kpiCard('Service (no user)', (data.unattributedCostCents / 100).toFixed(2) + ' €', 'indexing · OCR · embeddings').outerHTML +
    '</div>' +
    '<table class="adm-table"><thead><tr>' +
    ['Feature', 'Model', 'Calls', 'Input tok', 'Output tok', 'Cost']
      .map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' + rows + '</tbody></table>' +
    (top ? '<div class="adm-note" style="margin-top:10px">Top users: ' + top + '</div>' : '');
}

function _renderDangerUsers(users: DangerUser[]): void {
  const host = document.getElementById('adminDangerUsers');
  if (!host) return;
  host.innerHTML = '';
  if (!users.length) {
    host.innerHTML = '<div class="adm-empty">No paid users or AI usage yet.</div>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'adm-table';
  table.innerHTML =
    '<thead><tr>' +
    ['User', 'Plan', 'Revenue', 'AI cost', 'Profit', 'Calls', 'Status']
      .map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  users.forEach((u) => {
    const tag =
      u.flag === 'loss' ? '<span class="adm-tag red">Too costly</span>'
      : u.flag === 'high' ? '<span class="adm-tag">Watch</span>'
      : '<span class="adm-tag green">Healthy</span>';
    const profitColor = u.profitCents < 0 ? '#fb7185' : '#6ee7b7';
    const cells = [
      '<td class="lead">' + escapeHtml(u.email || u.userId.slice(0, 8) + '…') + '</td>',
      '<td>' + (u.paid ? 'Paid' : 'Free') + '</td>',
      '<td>' + _eur(u.revenueCents) + '</td>',
      '<td>' + _eur(u.aiCostCents) + '</td>',
      '<td style="color:' + profitColor + ';font-weight:700">' + _eur(u.profitCents) + '</td>',
      '<td>' + String(u.interactive + u.generation) + '</td>',
      '<td>' + tag + '</td>',
    ];
    const tr = document.createElement('tr');
    tr.innerHTML = cells.join('');
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(table);
}

// Editable cost config — euro inputs mapped to/from cents.
const _COST_FIELDS: Array<{ key: keyof CostConfig; label: string; unit: 'eur' | 'pct'; cents: boolean }> = [
  { key: 'monthlyPriceCents', label: 'Subscription price (€)', unit: 'eur', cents: true },
  { key: 'paymentFeePct', label: 'Payment fee (%)', unit: 'pct', cents: false },
  { key: 'paymentFeeFixedCents', label: 'Payment fee fixed (€)', unit: 'eur', cents: true },
  { key: 'aiInteractiveCostCents', label: 'Est. AI / interactive call (¢)', unit: 'pct', cents: false },
  { key: 'aiGenerationCostCents', label: 'Est. AI / generation call (¢)', unit: 'pct', cents: false },
  { key: 'aiInputCostCentsPerM', label: 'AI input (€ / 1M tokens)', unit: 'eur', cents: true },
  { key: 'aiOutputCostCentsPerM', label: 'AI output (€ / 1M tokens)', unit: 'eur', cents: true },
  { key: 'supabaseCostCents', label: 'Supabase / mo (€)', unit: 'eur', cents: true },
  { key: 'hostingCostCents', label: 'Hosting / mo (€)', unit: 'eur', cents: true },
  { key: 'otherCostCents', label: 'Other / mo (€)', unit: 'eur', cents: true },
];

function _renderCostConfig(cfg: CostConfig): void {
  const host = document.getElementById('adminCostConfig');
  if (!host || host.dataset['built'] === '1') return;
  host.dataset['built'] = '1';
  host.innerHTML =
    '<div class="adm-cfg-grid">' +
    _COST_FIELDS.map((f) => {
      const raw = cfg[f.key];
      const val = f.cents ? (raw / 100).toFixed(2) : String(raw);
      return (
        '<label>' + escapeHtml(f.label) +
        '<input data-cfg="' + f.key + '" type="number" step="0.01" min="0" value="' + escapeHtml(val) + '" /></label>'
      );
    }).join('') +
    '</div>' +
    '<button id="adminCostSave" class="sub-btn" style="width:auto;padding:8px 18px;font-size:.78rem;margin-top:12px">Save & recompute</button>';

  const saveBtn = document.getElementById('adminCostSave') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const next = {} as CostConfig;
      _COST_FIELDS.forEach((f) => {
        const el = host.querySelector<HTMLInputElement>('input[data-cfg="' + f.key + '"]');
        const num = el ? parseFloat(el.value) : NaN;
        const safe = Number.isFinite(num) && num >= 0 ? num : 0;
        next[f.key] = f.cents ? Math.round(safe * 100) : safe;
      });
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        if (adminSvc.saveCostConfig) await adminSvc.saveCostConfig(next);
        if (typeof window.showToast === 'function') window.showToast('Cost config saved', 'Recomputing profit…');
        await loadFinancials();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (typeof window.showToast === 'function') window.showToast('Save failed', msg);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save & recompute';
      }
    });
  }
}

// ── Activity & feature usage ────────────────────────────────────────────────

async function loadUsage(): Promise<void> {
  const cards = document.getElementById('adminActivityCards');
  if (!cards) return;
  const data: UsageStats | null = adminSvc.getUsageStats ? await adminSvc.getUsageStats() : null;
  if (!data) {
    cards.innerHTML = '<div class="adm-empty">Usage data unavailable.</div>';
    return;
  }
  cards.innerHTML = '';
  cards.appendChild(_miniCard('Active today', data.dau, '#7dd3fc'));
  cards.appendChild(_miniCard('This week', data.wau, '#7dd3fc'));
  cards.appendChild(_miniCard('This month', data.mau, '#6ee7b7'));

  const host = document.getElementById('adminFeatureUsage');
  if (!host) return;
  const feats = data.features || [];
  const max = feats.reduce((m, f) => (f.count > m ? f.count : m), 0) || 1;
  host.innerHTML =
    '<div style="font-size:11.5px;color:var(--on-glass-muted);font-weight:700;margin-bottom:12px">Feature usage this month</div>' +
    feats
      .map((f) => {
        const pct = Math.round((f.count / max) * 100);
        return (
          '<div class="adm-bar-row">' +
          '<span>' + escapeHtml(f.label) + '</span>' +
          '<div class="adm-track"><span style="width:' + (f.count > 0 ? Math.max(pct, 4) : 0) + '%"></span></div>' +
          '<b>' + f.count + '</b>' +
          '</div>'
        );
      })
      .join('');
}

// ── Retrieval inspector ────────────────────────────────────────────────────

function initRetrievalInspector(): void {
  const btn = document.getElementById('retrInspectorLoad');
  if (!btn) return;
  btn.addEventListener('click', loadRetrievalLogs);
}

function _fmtTs(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

async function loadRetrievalLogs(): Promise<void> {
  const list = document.getElementById('retrInspectorList');
  const detail = document.getElementById('retrInspectorDetail');
  if (!list) return;
  if (detail) detail.innerHTML = '';
  const userId = (document.getElementById('retrInspectorUser') as HTMLInputElement | null)?.value.trim() || undefined;
  const courseId = (document.getElementById('retrInspectorCourse') as HTMLInputElement | null)?.value.trim() || undefined;
  list.innerHTML =
    '<div style="color:var(--on-glass-muted);font-size:.85rem">Loading…</div>';
  try {
    const { rows } = await listRetrievalLogs({ userId, courseId, limit: 25 });
    if (!rows.length) {
      list.innerHTML =
        '<div style="color:var(--on-glass-muted);font-size:.85rem">No rows.</div>';
      return;
    }
    list.innerHTML = '';
    rows.forEach((r) => list.appendChild(_renderLogRow(r)));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    list.innerHTML = '<div style="color:#f87171;font-size:.85rem">Error: ' + escapeHtml(msg) + '</div>';
  }
}

function _renderLogRow(r: RetrievalLogLite): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText =
    'background:var(--glass-bg);border:1px solid var(--glass-border);' +
    'border-radius:12px;padding:10px 14px;margin-bottom:8px;cursor:pointer';
  const mode = r.retrieval_mode || '?';
  const modeColor = mode === 'strong' ? '#22c55e' : mode === 'weak' ? '#facc15' : '#94a3b8';
  card.innerHTML =
    '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
      '<div style="font-weight:700;color:var(--on-glass);font-size:.88rem;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        escapeHtml(r.question) +
      '</div>' +
      '<div style="font-size:.72rem;color:' + modeColor + ';font-weight:700">' + escapeHtml(mode) + '</div>' +
    '</div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:.72rem;color:var(--on-glass-muted);margin-top:4px">' +
      '<span>' + _fmtTs(r.created_at) + '</span>' +
      '<span>course: ' + escapeHtml(r.course_id) + '</span>' +
      '<span>endpoint: ' + escapeHtml(r.endpoint) + '</span>' +
      (r.cache_hit ? '<span style="color:#60a5fa">cache</span>' : '') +
      (r.retrieval_strategy ? '<span>strategy: ' + escapeHtml(r.retrieval_strategy) + '</span>' : '') +
      (r.candidate_doc_count != null ? '<span>docs: ' + r.candidate_doc_count + '</span>' : '') +
    '</div>';
  card.addEventListener('click', () => loadLogDetail(r.id));
  return card;
}

async function loadLogDetail(id: string): Promise<void> {
  const detail = document.getElementById('retrInspectorDetail');
  if (!detail) return;
  detail.innerHTML =
    '<div style="color:var(--on-glass-muted);font-size:.85rem">Loading detail…</div>';
  try {
    const { row } = await getRetrievalLog(id);
    detail.innerHTML = '';
    detail.appendChild(_renderLogDetail(row));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    detail.innerHTML = '<div style="color:#f87171;font-size:.85rem">Error: ' + escapeHtml(msg) + '</div>';
  }
}

function _renderLogDetail(r: RetrievalLogFull): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'background:var(--glass-bg);border:1px solid var(--glass-border);' +
    'border-radius:14px;padding:16px 18px';

  const head = document.createElement('div');
  head.innerHTML =
    '<div style="font-weight:800;font-size:.95rem;color:var(--on-glass);margin-bottom:6px">' +
      escapeHtml(r.question) +
    '</div>' +
    '<div style="font-size:.72rem;color:var(--on-glass-muted);display:flex;flex-wrap:wrap;gap:10px">' +
      '<span>' + _fmtTs(r.created_at) + '</span>' +
      '<span>user: ' + escapeHtml(r.user_id) + '</span>' +
      '<span>course: ' + escapeHtml(r.course_id) + '</span>' +
      '<span>endpoint: ' + escapeHtml(r.endpoint) + '</span>' +
      (r.active_document_id ? '<span>active doc: ' + escapeHtml(r.active_document_id) + '</span>' : '') +
      (r.selected_document_ids?.length ? '<span>selected: ' + r.selected_document_ids.length + '</span>' : '') +
      '<span>strategy: ' + escapeHtml(r.retrieval_strategy || '?') + '</span>' +
      '<span>mode: ' + escapeHtml(r.retrieval_mode || '?') + '</span>' +
      (r.cache_hit ? '<span style="color:#60a5fa">cache hit</span>' : '') +
      (r.model ? '<span>model: ' + escapeHtml(r.model) + '</span>' : '') +
      (r.prompt_tokens != null ? '<span>tok in: ' + r.prompt_tokens + '</span>' : '') +
      (r.completion_tokens != null ? '<span>tok out: ' + r.completion_tokens + '</span>' : '') +
    '</div>';
  wrap.appendChild(head);

  if (r.exercise_hit) {
    const ex = document.createElement('pre');
    ex.style.cssText =
      'margin-top:12px;padding:10px 12px;background:rgba(34,197,94,.08);' +
      'border:1px solid rgba(34,197,94,.3);border-radius:10px;font-size:.72rem;overflow:auto';
    ex.textContent = 'exact hits: ' + JSON.stringify(r.exercise_hit, null, 2);
    wrap.appendChild(ex);
  }
  if (r.error) {
    const err = document.createElement('div');
    err.style.cssText =
      'margin-top:12px;padding:10px 12px;background:rgba(248,113,113,.08);' +
      'border:1px solid rgba(248,113,113,.4);border-radius:10px;font-size:.78rem;color:#fecaca';
    err.textContent = 'error: ' + r.error;
    wrap.appendChild(err);
  }

  const chunks = Array.isArray(r.chunk_metadata) ? r.chunk_metadata : [];
  const chunksTitle = document.createElement('div');
  chunksTitle.style.cssText = 'margin-top:14px;font-weight:700;color:var(--on-glass);font-size:.82rem';
  chunksTitle.textContent = 'Top chunks (' + chunks.length + ')';
  wrap.appendChild(chunksTitle);

  chunks.forEach((c: RetrievalChunkMeta, i: number) => {
    const row = document.createElement('div');
    row.style.cssText =
      'margin-top:8px;padding:10px 12px;border:1px solid var(--glass-border);' +
      'border-radius:10px;background:rgba(255,255,255,.02)';
    const pages = c.pageStart != null
      ? (c.pageEnd && c.pageEnd !== c.pageStart ? c.pageStart + '-' + c.pageEnd : String(c.pageStart))
      : '?';
    row.innerHTML =
      '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:.72rem;color:var(--on-glass-muted)">' +
        '<span style="font-weight:800;color:var(--on-glass)">#' + (i + 1) + '</span>' +
        (c.fileName ? '<span>' + escapeHtml(c.fileName) + '</span>' : '') +
        '<span>p.' + escapeHtml(pages) + '</span>' +
        (c.chunkType ? '<span>type: ' + escapeHtml(c.chunkType) + '</span>' : '') +
        (c.synthetic ? '<span style="color:#60a5fa">exact</span>' : '') +
        (c.sectionTitle ? '<span>§ ' + escapeHtml(c.sectionTitle) + '</span>' : '') +
        (c.score != null ? '<span>score: ' + c.score.toFixed(3) + '</span>' : '') +
        (c.similarity != null ? '<span>sim: ' + c.similarity.toFixed(3) + '</span>' : '') +
      '</div>' +
      (c.excerpt
        ? '<div style="margin-top:6px;font-size:.78rem;color:var(--on-glass);white-space:pre-wrap">' +
            escapeHtml(c.excerpt) + '</div>'
        : '');
    wrap.appendChild(row);
  });

  return wrap;
}

async function adminSearch(): Promise<void> {
  const input = document.getElementById('adminSearchInput') as HTMLInputElement | null;
  const results = document.getElementById('adminResults');
  if (!results) return;
  const q = (input?.value || '').trim();
  if (!q) return;
  results.innerHTML =
    '<div style="color:var(--on-glass-muted);font-size:.85rem">Searching...</div>';
  try {
    const users = (await searchUsers(q)) as AdminUser[] | unknown;
    if (!Array.isArray(users) || !users.length) {
      results.innerHTML =
        '<div style="color:var(--on-glass-muted);font-size:.85rem">No users found.</div>';
      return;
    }
    results.innerHTML = '';
    (users as AdminUser[]).forEach((u) => {
      const isPro = u.plan === 'pro' && u.status === 'active';
      const isNew = _isNewUser(u.created_at);
      const joined = u.created_at ? new Date(u.created_at).toLocaleDateString() : '';

      const card = document.createElement('div');
      card.style.cssText =
        'background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:14px;padding:14px 18px;margin-bottom:10px;display:flex;align-items:center;gap:12px';
      if (isNew) {
        card.style.borderColor = 'rgba(16,185,129,.45)';
        card.style.background = 'rgba(16,185,129,.07)';
      }

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      const emailEl = document.createElement('div');
      emailEl.style.cssText = 'font-weight:800;color:var(--on-glass);font-size:.88rem;display:flex;align-items:center;gap:8px';
      emailEl.textContent = u.email || '';
      if (isNew) emailEl.appendChild(_newChip());

      const joinedEl = document.createElement('div');
      joinedEl.style.cssText = 'font-size:.72rem;color:var(--on-glass-muted)';
      joinedEl.textContent = 'Joined ' + joined;

      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'font-size:.75rem;margin-top:4px;font-weight:800;color:' + (isPro ? '#22c55e' : '#f87171');
      statusEl.textContent = isPro ? '✓ Pro (subscribed)' : '✕ Free (not subscribed)';

      info.append(emailEl, joinedEl, statusEl);

      const actionBtn = document.createElement('button');
      actionBtn.className = 'sub-btn ' + (isPro ? 'sub-btn-current' : 'sub-btn-upgrade');
      actionBtn.dataset.uid = u.id;
      actionBtn.dataset.pro = String(isPro);
      actionBtn.style.cssText = 'width:auto;padding:8px 18px;font-size:.78rem';
      actionBtn.textContent = isPro ? 'Revoke Pro' : 'Grant Pro';

      actionBtn.addEventListener('click', async function (this: HTMLButtonElement) {
        const uid = this.dataset.uid || '';
        const grantPro = this.dataset.pro === 'false';
        this.textContent = '...';
        this.disabled = true;
        try {
          await setUserPlan(uid, grantPro ? 'pro' : 'free');
          if (typeof window.showToast === 'function')
            window.showToast(grantPro ? '✓ Pro granted' : 'Pro revoked', u.email);
          adminSearch();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (typeof window.showToast === 'function') window.showToast('Error', msg);
          this.disabled = false;
        }
      });

      const reindexBtn = document.createElement('button');
      reindexBtn.className = 'sub-btn';
      reindexBtn.dataset.uid = u.id;
      reindexBtn.style.cssText = 'width:auto;padding:8px 14px;font-size:.72rem;margin-left:6px';
      reindexBtn.textContent = 'Reindex course…';
      reindexBtn.addEventListener('click', async function (this: HTMLButtonElement) {
        const uid = this.dataset.uid || '';
        const courseId = (window.prompt('Course ID to reindex for ' + (u.email || uid) + ':') || '').trim();
        if (!courseId) return;
        this.disabled = true;
        const origText = this.textContent;
        this.textContent = 'Checking…';
        try {
          const dry = await reindexUserCourse(uid, courseId, true);
          const n = typeof dry.count === 'number' ? dry.count : 0;
          if (dry.error) throw new Error(dry.error);
          if (!n) {
            if (typeof window.showToast === 'function') window.showToast('No documents', 'Course "' + courseId + '" has 0 docs for this user.');
            return;
          }
          if (!window.confirm('Reindex ' + n + ' document(s) in course "' + courseId + '"? This clears chunks/pages and re-runs the indexer.')) return;
          this.textContent = 'Reindexing…';
          const real = await reindexUserCourse(uid, courseId, false);
          if (real.error) throw new Error(real.error);
          if (typeof window.showToast === 'function')
            window.showToast('Reindex queued', 'Total ' + (real.total ?? 0) + ' · kicked ' + (real.kicked ?? 0) + (real.failed ? ' · failed ' + real.failed : ''));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (typeof window.showToast === 'function') window.showToast('Error', msg);
        } finally {
          this.disabled = false;
          this.textContent = origText;
        }
      });

      card.append(info, actionBtn, reindexBtn);
      results.appendChild(card);
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.innerHTML = '<div style="color:#f87171;font-size:.85rem">Error: ' + escapeHtml(msg) + '</div>';
  }
}

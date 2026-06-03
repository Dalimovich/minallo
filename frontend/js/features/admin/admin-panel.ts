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
} from '../../services/admin-service.js';
// Analytics functions are reached via a namespace import on purpose: this
// module is lazy-imported when the admin page opens, and a stale browser-cached
// admin-service.js (missing these newer exports) would otherwise fail to LINK
// the whole admin module and stop the page from opening at all. With a
// namespace import a missing export is just `undefined`, so the dashboard
// degrades to absent while the rest of the admin page still works.
import * as adminSvc from '../../services/admin-service.js';
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
  try {
    await Promise.all([loadFinancials(), loadUsage(), reloadSignupChart(), loadSubscriptionCards(), loadRetention()]);
    if (loading) loading.style.display = 'none';
    if (body) body.style.display = '';
  } catch {
    if (loading) loading.textContent = 'Could not load stats.';
    _statsLoaded = false; // allow a retry on next open
  }
}

async function reloadSignupChart(): Promise<void> {
  const rangeSel = document.getElementById('adminRangeSel') as HTMLSelectElement | null;
  const bucketSel = document.getElementById('adminBucketSel') as HTMLSelectElement | null;
  const range = rangeSel?.value || '30d';
  const bucket = bucketSel?.value || _defaultBucketFor(range);
  const data = adminSvc.getSignupStats ? await adminSvc.getSignupStats(range, bucket) : null;
  if (data) {
    _renderGrowthCards(data);
    _renderSignupChart(data);
  }
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

function _renderSignupChart(data: SignupStats): void {
  const host = document.getElementById('adminSignupChart');
  if (!host) return;
  host.innerHTML = '';
  const series = data.series || [];
  if (!series.length) {
    host.innerHTML = '<div class="adm-empty">No signups in this range.</div>';
    return;
  }
  const max = series.reduce((m, p) => (p.count > m ? p.count : m), 0) || 1;
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;align-items:flex-end;gap:2px;height:150px;padding:8px 2px;overflow-x:auto';
  for (const p of series) {
    const col = document.createElement('div');
    col.style.cssText = 'flex:1 0 6px;min-width:6px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%';
    col.title = p.date + ': ' + p.count;
    const bar = document.createElement('div');
    const h = Math.round((p.count / max) * 100);
    bar.style.cssText =
      'width:100%;border-radius:4px 4px 0 0;background:linear-gradient(180deg,#38bdf8,#0284c7);' +
      'height:' + (p.count > 0 ? Math.max(h, 3) : 0) + '%;transition:height .2s';
    col.appendChild(bar);
    wrap.appendChild(col);
  }
  host.appendChild(wrap);
  const caption = document.createElement('div');
  caption.style.cssText = 'font-size:.72rem;color:var(--on-glass-muted);margin-top:6px';
  caption.textContent =
    data.total + ' signups · ' + series[0]!.date + ' → ' + series[series.length - 1]!.date +
    ' · peak ' + max + '/' + data.bucket;
  host.appendChild(caption);
}

async function loadSubscriptionCards(): Promise<void> {
  const host = document.getElementById('adminSubCards');
  if (!host) return;
  const data: SubscriptionStats | null = adminSvc.getSubscriptionStats ? await adminSvc.getSubscriptionStats() : null;
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
    '</div>';
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
  { key: 'aiInteractiveCostCents', label: 'AI cost / interactive call (¢)', unit: 'pct', cents: false },
  { key: 'aiGenerationCostCents', label: 'AI cost / generation call (¢)', unit: 'pct', cents: false },
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
      const joined = u.created_at ? new Date(u.created_at).toLocaleDateString() : '';

      const card = document.createElement('div');
      card.style.cssText =
        'background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:14px;padding:14px 18px;margin-bottom:10px;display:flex;align-items:center;gap:12px';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      const emailEl = document.createElement('div');
      emailEl.style.cssText = 'font-weight:800;color:var(--on-glass);font-size:.88rem';
      emailEl.textContent = u.email || '';

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

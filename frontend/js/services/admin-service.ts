interface AdminFetchBody {
  action:
    | 'status' | 'search' | 'setplan' | 'reports' | 'resolvereport' | 'deleteself'
    | 'signups' | 'newusers' | 'subscriptions' | 'retention'
    | 'financials' | 'financeseries' | 'getcostconfig' | 'savecostconfig' | 'usage' | 'aiusage' | 'usageexport';
  [k: string]: unknown;
}

function _adminFetch(body: AdminFetchBody): Promise<Response> {
  return fetch('/api/admin-users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window._sbToken || ''),
    },
    body: JSON.stringify(body),
  });
}

export async function checkAdminStatus(): Promise<unknown> {
  const res = await _adminFetch({ action: 'status' });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function searchUsers(query: string): Promise<unknown> {
  const res = await _adminFetch({ action: 'search', query });
  return res.json();
}

export async function setUserPlan(userId: string, plan: 'free' | 'pro'): Promise<void> {
  await _adminFetch({ action: 'setplan', userId, plan });
}

// ── Admin analytics ─────────────────────────────────────────────────────────

export interface SignupStats {
  total: number;
  range: string;
  bucket: string;
  series: Array<{ date: string; count: number }>;
  summary: { today: number; week: number; month: number; year: number; total: number; currentUsers: number };
}

export async function getSignupStats(range: string, bucket?: string): Promise<SignupStats | null> {
  const body: AdminFetchBody = { action: 'signups', range };
  if (bucket) body.bucket = bucket;
  const res = await _adminFetch(body);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface NewUser {
  id: string;
  email?: string;
  created_at?: string;
  plan: string;
  status: string;
}

export interface NewUsersResult {
  users: NewUser[];
  hours: number;
}

export async function getNewUsers(): Promise<NewUsersResult | null> {
  const res = await _adminFetch({ action: 'newusers' });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface SubscriptionStats {
  totalSubs: number;
  trialsStarted: number;
  converted: number;
  conversionRate: number;
  activePaid: number;
  trialing: number;
  cancelled: number;
  pastDue: number;
  paused: number;
}

export async function getSubscriptionStats(): Promise<SubscriptionStats | null> {
  const res = await _adminFetch({ action: 'subscriptions' });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface RetentionMonth {
  month: string;
  active: number;
  newPaid: number;
  renewed: number;
  cancelled: number;
}
export interface RetentionStats {
  series: RetentionMonth[];
  months: number;
  available: boolean;
}

export async function getRetentionStats(months = 12): Promise<RetentionStats | null> {
  const res = await _adminFetch({ action: 'retention', months });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ── Activity & feature usage ────────────────────────────────────────────────

export interface UsageStats {
  dau: number;
  wau: number;
  mau: number;
  features: Array<{ key: string; label: string; count: number }>;
}

export async function getUsageStats(): Promise<UsageStats | null> {
  const res = await _adminFetch({ action: 'usage' });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ── Financial overview ──────────────────────────────────────────────────────

export interface CostConfig {
  monthlyPriceCents: number;
  paymentFeePct: number;
  paymentFeeFixedCents: number;
  aiInteractiveCostCents: number;
  aiGenerationCostCents: number;
  aiInputCostCentsPerM: number;
  aiOutputCostCentsPerM: number;
  supabaseCostCents: number;
  hostingCostCents: number;
  otherCostCents: number;
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

export interface FinancialStats {
  activePaid: number;
  totalUsersWithUsage: number;
  mrrCents: number;
  revenueCents: number;
  aiCostCents: number;
  paymentFeesCents: number;
  fixedCostsCents: number;
  netProfitCents: number;
  profitMargin: number;
  aiCostPerUserCents: number;
  aiCostPerPaidUserCents: number;
  profitPerPaidUserCents: number;
  interactiveCalls: number;
  generationCalls: number;
  measuredAiCostCents: number;
  estimatedAiCostCents: number;
  dangerUsers: DangerUser[];
  config: CostConfig;
}

export async function getFinancials(): Promise<FinancialStats | null> {
  const res = await _adminFetch({ action: 'financials' });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface FinanceSeriesPoint {
  month: string;
  revenueCents: number;
  aiCostCents: number;
  feesCents: number;
  fixedCents: number;
  costCents: number;
  profitCents: number;
  activePaid: number;
  aiCalls: number;
}
export interface FinanceSeries {
  series: FinanceSeriesPoint[];
  months: number;
  dataMonths: number;
  retentionAvailable: boolean;
}

export async function getFinanceSeries(months = 6): Promise<FinanceSeries | null> {
  const res = await _adminFetch({ action: 'financeseries', months });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function getCostConfig(): Promise<CostConfig | null> {
  const res = await _adminFetch({ action: 'getcostconfig' });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && typeof data === 'object' && 'config' in data ? (data as { config: CostConfig }).config : null;
}

export async function saveCostConfig(config: CostConfig): Promise<FinancialStats['config'] | null> {
  const res = await _adminFetch({ action: 'savecostconfig', config });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && typeof data === 'object' && 'config' in data ? (data as { config: CostConfig }).config : null;
}

// ── AI usage meter (usage_events) ────────────────────────────────────────────

export interface AiUsageLine {
  feature: string;
  model: string;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costCents: number;
}

export interface AiUsageStats {
  available: boolean;          // false until the usage_events migration is applied
  days: number;
  lines: AiUsageLine[];
  totalCostCents: number;
  totalRequests: number;
  unattributedCostCents: number;
  topUsers: Array<{ userId: string; costCents: number; email?: string }>;
}

export async function getAiUsage(days = 30): Promise<AiUsageStats | null> {
  const res = await _adminFetch({ action: 'aiusage', days });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ── Per-user cost/revenue/profit export (downloadable report) ────────────────

export interface UsageExportRow {
  userId: string;
  email?: string;
  paid: boolean;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  aiCostCents: number;
  revenueCents: number;
  feeCents: number;
  profitCents: number;
}

export interface UsageExport {
  available: boolean;       // false until the usage_events migration is applied
  days: number;
  since: string;
  until: string | null;     // set when an explicit from/to range was used
  period: string;           // human-readable label of the window
  generatedAt: string;
  rows: UsageExportRow[];
}

// Pass either a preset { days } window OR an explicit { from, to } range
// (YYYY-MM-DD, inclusive). When from+to are both set they take precedence.
export async function getUsageExport(
  params: { days?: number; from?: string; to?: string } = {},
): Promise<UsageExport | null> {
  const body: AdminFetchBody = { action: 'usageexport' };
  if (params.from && params.to) {
    body.from = params.from;
    body.to = params.to;
  } else {
    body.days = params.days ?? 30;
  }
  const res = await _adminFetch(body);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface ReindexCourseResult {
  dryRun?: boolean;
  count?: number;
  total?: number;
  kicked?: number;
  failed?: number;
  error?: string;
}

export async function reindexUserCourse(
  userId: string, courseId: string, dryRun: boolean
): Promise<ReindexCourseResult> {
  const res = await fetch('/api/documents/reindex-course', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window._sbToken || ''),
    },
    body: JSON.stringify({ userId, courseId, dryRun }),
  });
  return res.json().catch(() => ({ error: 'Bad response' })) as Promise<ReindexCourseResult>;
}

// Retrieval inspector — admin-only view over public.retrieval_debug_log.
export interface RetrievalLogLite {
  id: string;
  user_id: string;
  course_id: string;
  endpoint: string;
  question: string;
  active_document_id: string | null;
  selected_document_ids: string[];
  retrieval_strategy: string | null;
  retrieval_mode: string | null;
  candidate_doc_count: number | null;
  cache_hit: boolean;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface RetrievalChunkMeta {
  chunkId?: string;
  documentId?: string;
  fileName?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  score?: number;
  similarity?: number;
  chunkType?: string;
  sectionTitle?: string | null;
  synthetic?: boolean;
  excerpt?: string;
}

export interface RetrievalLogFull extends RetrievalLogLite {
  exercise_hit: unknown;
  chunk_metadata: RetrievalChunkMeta[];
  error: string | null;
}

function _adminGet<T>(body: Record<string, unknown>): Promise<T> {
  return fetch('/api/admin/retrieval-logs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (window._sbToken || ''),
    },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<T>);
}

export function listRetrievalLogs(
  filter?: { userId?: string; courseId?: string; limit?: number },
): Promise<{ rows: RetrievalLogLite[] }> {
  return _adminGet<{ rows: RetrievalLogLite[] }>({
    userId: filter?.userId,
    courseId: filter?.courseId,
    limit: filter?.limit || 25,
  });
}

export function getRetrievalLog(id: string): Promise<{ row: RetrievalLogFull }> {
  return _adminGet<{ row: RetrievalLogFull }>({ id });
}

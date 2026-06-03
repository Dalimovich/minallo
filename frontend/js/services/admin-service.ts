interface AdminFetchBody {
  action:
    | 'status' | 'search' | 'setplan' | 'reports' | 'resolvereport' | 'deleteself'
    | 'signups' | 'subscriptions' | 'retention'
    | 'financials' | 'getcostconfig' | 'savecostconfig';
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

// ── Financial overview ──────────────────────────────────────────────────────

export interface CostConfig {
  monthlyPriceCents: number;
  paymentFeePct: number;
  paymentFeeFixedCents: number;
  aiInteractiveCostCents: number;
  aiGenerationCostCents: number;
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
  dangerUsers: DangerUser[];
  config: CostConfig;
}

export async function getFinancials(): Promise<FinancialStats | null> {
  const res = await _adminFetch({ action: 'financials' });
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

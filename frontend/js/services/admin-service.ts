interface AdminFetchBody {
  action: 'status' | 'search' | 'setplan' | 'reports' | 'resolvereport' | 'deleteself';
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

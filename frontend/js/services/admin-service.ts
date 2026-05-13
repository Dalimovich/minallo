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

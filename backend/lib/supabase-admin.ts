// Supabase REST API helper using the service-role key.
// Reads SUPABASE_URL from env at call time so this module is safe to require at load time.
//
// Uses Web `fetch` (not Node `https.request`) so this runs on Workers too —
// unenv's nodejs_compat shim doesn't implement https.request.

import { requireEnv } from './env';
import type { HttpHeaders, SupaResult } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const _DEFAULT_TIMEOUT_MS = 12000;

async function _fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<SupaResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: T;
    try {
      body = (text ? JSON.parse(text) : null) as T;
    } catch {
      body = text as unknown as T;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function supaRequest<T = unknown>(
  method: HttpMethod,
  path: string,
  body: unknown,
  serviceKey: string,
  extraHeaders?: HttpHeaders
): Promise<SupaResult<T>> {
  const supaUrl = requireEnv('SUPABASE_URL');
  const headers: HttpHeaders = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(extraHeaders || {})
  };
  return _fetchJson<T>(
    supaUrl.replace(/\/$/, '') + '/rest/v1/' + path,
    {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    },
    _DEFAULT_TIMEOUT_MS
  );
}

// Supabase Auth Admin API (e.g. /auth/v1/admin/users)
export function supaAuthAdminRequest<T = unknown>(
  method: HttpMethod,
  path: string,
  serviceKey: string
): Promise<SupaResult<T>> {
  const supaUrl = requireEnv('SUPABASE_URL');
  return _fetchJson<T>(
    supaUrl.replace(/\/$/, '') + '/auth/v1/admin/' + path,
    {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey
      }
    },
    _DEFAULT_TIMEOUT_MS
  );
}

export interface ActiveSubscription {
  plan?: string;
  status: string;
  expires_at?: string | null;
}

/**
 * Fetches the user's subscription and returns it only if it is genuinely active
 * (status = 'active' AND expires_at is either null or in the future).
 * Returns null if the user has no subscription or if it has expired.
 */
export async function getActiveSubscription(
  serviceKey: string,
  userId: string
): Promise<ActiveSubscription | null> {
  const result = await supaRequest<ActiveSubscription[]>(
    'GET',
    'subscriptions?user_id=eq.' + encodeURIComponent(userId) +
      '&select=plan,status,expires_at&limit=1',
    null,
    serviceKey
  );
  const sub = Array.isArray(result.body) ? result.body[0] : undefined;
  if (!sub) return null;
  if (sub.status !== 'active') return null;
  if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
    // Subscription has expired — mark it cancelled so future reads are consistent.
    supaRequest(
      'PATCH',
      'subscriptions?user_id=eq.' + encodeURIComponent(userId),
      { status: 'expired', updated_at: new Date().toISOString() },
      serviceKey,
      { Prefer: 'return=minimal' }
    ).catch(function (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[supabase-admin] subscription expiry patch error:', msg);
    });
    return null;
  }
  return sub;
}

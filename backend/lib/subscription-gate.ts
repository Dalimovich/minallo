// Subscription-gate helper for paid AI endpoints.
//
// Reads the user's row from `public.subscriptions` via the service-role key,
// and returns a 402 LambdaResponse when the row is missing, cancelled, or
// expired. Endpoints call this once per request before forwarding to Python.
//
// The paywall is UI-only on the frontend; without this check, any signed-up
// user can call the AI endpoints with their JWT and burn OpenAI budget.

import { supaRequest } from './supabase-admin';
import { fail } from './responses';
import { logSecurityEvent } from './logger';
import type { LambdaResponse } from './types';

interface SubscriptionRow {
  status?: string;
  plan?: string;
  expires_at?: string | null;
}

interface AdminRow { user_id: string }

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

/** Returns null when the user is allowed to use paid features, or a 402
 *  LambdaResponse otherwise. The endpoint should `return` whatever this
 *  returns when non-null, mirroring the enforceEventRateLimit pattern. */
export async function requireActiveSubscription(
  serviceKey: string,
  userId: string,
  reason: string
): Promise<LambdaResponse | null> {
  // Admins bypass the paywall — same row in `admins` table that other admin
  // endpoints (admin-users.ts) check against.
  const adminRes = await supaRequest<AdminRow[]>(
    'GET',
    'admins?user_id=eq.' + encodeURIComponent(userId) + '&select=user_id&limit=1',
    null,
    serviceKey
  );
  if (Array.isArray(adminRes.body) && adminRes.body[0]?.user_id === userId) {
    return null;
  }

  const path =
    'subscriptions?user_id=eq.' + encodeURIComponent(userId) +
    '&select=status,plan,expires_at&limit=1';
  const res = await supaRequest<SubscriptionRow[]>('GET', path, null, serviceKey);
  const row = Array.isArray(res.body) ? res.body[0] : undefined;

  const status = row?.status ?? '';
  const expires = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  const now = Date.now();
  const ok = ACTIVE_STATUSES.has(status) && expires > now;

  if (ok) return null;

  // Log the gate failure so we can spot abuse attempts in security_events.
  await logSecurityEvent(serviceKey, userId, 'subscription_gate_blocked', {
    reason,
    status: status || 'none',
    expired_for_seconds: expires ? Math.max(0, Math.floor((now - expires) / 1000)) : null
  }).catch(() => undefined);

  return fail(402, 'Active subscription required.');
}

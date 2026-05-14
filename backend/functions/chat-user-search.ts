import { requireEnv } from '../lib/env';
import { jsonResponse, fail } from '../lib/responses';
import { getCorsHeaders } from '../lib/cors';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { countRecentEvents, rateLimitResponse } from '../lib/rate-limit';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const SEARCH_RATE_LIMIT_MAX = 120;
const SEARCH_RATE_LIMIT_WINDOW = 60 * 60 * 1000;

interface BlockRow { blocker_id: string; blocked_id: string }
interface ProfileRow { id: string; full_name?: string; chat_username?: string; programme?: string }

function escLike(value: unknown): string {
  return String(value || '').replace(/[,%]/g, '');
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  const corsHeaders = { ...getCorsHeaders(), 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  const q = escLike((event.queryStringParameters && event.queryStringParameters.q) || '').trim();
  if (q.length < 2) return fail(400, 'Search query must be at least 2 characters');
  if (q.length > 50) return fail(400, 'Search query is too long');

  try {
    const searchCount = await countRecentEvents(serviceKey, user.id, 'chat_user_search', SEARCH_RATE_LIMIT_WINDOW);
    if (searchCount >= SEARCH_RATE_LIMIT_MAX) {
      await logSecurityEvent(serviceKey, user.id, 'chat_user_search_rate_limited', { count: searchCount });
      return rateLimitResponse(SEARCH_RATE_LIMIT_WINDOW, 'Search limit reached. Please try again later.');
    }
    await logSecurityEvent(serviceKey, user.id, 'chat_user_search', {});

    const blockedPath = 'blocked_users?or=(blocker_id.eq.' + encodeURIComponent(user.id) +
      ',blocked_id.eq.' + encodeURIComponent(user.id) + ')&select=blocker_id,blocked_id';
    const blockedRes = await supaRequest<BlockRow[]>('GET', blockedPath, null, serviceKey);
    if (blockedRes.status < 200 || blockedRes.status >= 300) return fail(500, 'Could not load blocked users');

    const blockedIds = new Set<string>(
      (Array.isArray(blockedRes.body) ? blockedRes.body : [])
        .map((row) => row.blocker_id === user.id ? row.blocked_id : row.blocker_id)
        .filter(Boolean)
    );

    const qEnc = encodeURIComponent('*' + q + '*');
    const select = 'select=id,full_name,chat_username,programme&limit=8';
    const seen: Record<string, true> = {};
    const rows: Array<{ id: string; full_name: string | null; chat_username: string | null; programme: string }> = [];
    const paths = [
      'public_profiles?full_name=ilike.' + qEnc + '&' + select,
      'public_profiles?chat_username=ilike.' + qEnc + '&' + select
    ];

    for (const path of paths) {
      const res = await supaRequest<ProfileRow[]>('GET', path, null, serviceKey);
      if (res.status < 200 || res.status >= 300) return fail(500, 'Profile search failed');
      const data = Array.isArray(res.body) ? res.body : [];
      data.forEach((p) => {
        if (!p || !p.id || p.id === user.id || blockedIds.has(p.id) || seen[p.id]) return;
        seen[p.id] = true;
        rows.push({
          id: p.id,
          full_name: p.full_name || null,
          chat_username: p.chat_username || null,
          programme: p.programme || ''
        });
      });
    }

    return jsonResponse(200, { users: rows.slice(0, 8) });
  } catch {
    return fail(500, 'Search failed');
  }
};

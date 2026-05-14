import { requireEnv } from '../lib/env';
import { jsonResponse, fail } from '../lib/responses';
import { getCorsHeaders } from '../lib/cors';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface FriendshipRow { id: string; user_id: string; friend_id: string; status: string }
interface BlockRow { blocker_id: string; blocked_id: string }
interface ProfileRow {
  id: string; full_name?: string; chat_username?: string; programme?: string; last_seen?: string;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  const corsHeaders = { ...getCorsHeaders(), 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired session');

  try {
    const friendshipPath = 'friendships?or=(user_id.eq.' + encodeURIComponent(user.id) +
      ',friend_id.eq.' + encodeURIComponent(user.id) + ')&select=id,user_id,friend_id,status';
    const friendshipRes = await supaRequest<FriendshipRow[]>('GET', friendshipPath, null, serviceKey);
    if (friendshipRes.status < 200 || friendshipRes.status >= 300) return fail(500, 'Could not load friendships');

    const blockedPath = 'blocked_users?or=(blocker_id.eq.' + encodeURIComponent(user.id) +
      ',blocked_id.eq.' + encodeURIComponent(user.id) + ')&select=blocker_id,blocked_id';
    const blockedRes = await supaRequest<BlockRow[]>('GET', blockedPath, null, serviceKey);
    if (blockedRes.status < 200 || blockedRes.status >= 300) return fail(500, 'Could not load blocked users');

    const blockedIds = new Set<string>(
      (Array.isArray(blockedRes.body) ? blockedRes.body : [])
        .map((row) => row.blocker_id === user.id ? row.blocked_id : row.blocker_id)
        .filter(Boolean)
    );

    const rows = (Array.isArray(friendshipRes.body) ? friendshipRes.body : []).filter((r) => {
      const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
      return otherId && !blockedIds.has(otherId);
    });
    const otherIds = Array.from(new Set(
      rows.map((r) => r.user_id === user.id ? r.friend_id : r.user_id).filter(Boolean)
    ));

    const profileMap: Record<string, ProfileRow> = {};
    if (otherIds.length) {
      const profilePath = 'public_profiles?id=in.(' + otherIds.map(encodeURIComponent).join(',') +
        ')&select=id,full_name,chat_username,programme,last_seen';
      const profileRes = await supaRequest<ProfileRow[]>('GET', profilePath, null, serviceKey);
      const profiles = Array.isArray(profileRes.body) ? profileRes.body : [];
      profiles.forEach((p) => { profileMap[p.id] = p; });
    }

    const friends = rows.map((r) => {
      const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
      const prof = profileMap[otherId] || ({} as Partial<ProfileRow>);
      return {
        id: r.id,
        otherId,
        status: r.status,
        isSender: r.user_id === user.id,
        profile: {
          id: otherId,
          full_name: prof.full_name || prof.chat_username || 'Student',
          chat_username: prof.chat_username || null,
          programme: prof.programme || '',
          last_seen: prof.last_seen || null
        }
      };
    });

    return jsonResponse(200, { friends });
  } catch {
    return fail(500, 'Could not load friends');
  }
};

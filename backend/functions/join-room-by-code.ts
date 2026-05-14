import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { requireEnv } from '../lib/env';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface RoomRow { id: string; name?: string; visibility?: string }

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired session');

  let inviteCode: string;
  try {
    const parsed = JSON.parse(event.body || '{}') as Record<string, unknown>;
    inviteCode = String(parsed.code || '').trim();
  } catch { return fail(400, 'Invalid body'); }

  if (!inviteCode || inviteCode.length > 128) return fail(400, 'Invalid invite code');

  try {
    const roomRes = await supaRequest<RoomRow[]>(
      'GET',
      'custom_rooms?invite_code=eq.' + encodeURIComponent(inviteCode) +
        '&select=id,name,visibility&limit=1',
      null, serviceKey
    );
    if (roomRes.status < 200 || roomRes.status >= 300) return fail(500, 'Could not look up invite code');
    const room = Array.isArray(roomRes.body) ? roomRes.body[0] : null;
    if (!room || !room.id) return fail(404, 'Invalid invite code');

    const memberPath = 'room_members?room_id=eq.' + encodeURIComponent(room.id) +
      '&user_id=eq.' + encodeURIComponent(user.id) + '&select=id&limit=1';
    const existingRes = await supaRequest<unknown[]>('GET', memberPath, null, serviceKey);

    if (!Array.isArray(existingRes.body) || !existingRes.body[0]) {
      const insertRes = await supaRequest('POST', 'room_members',
        { room_id: room.id, user_id: user.id }, serviceKey);
      if (insertRes.status < 200 || insertRes.status >= 300) return fail(500, 'Could not join room');
    }

    return jsonResponse(200, {
      ok: true,
      room: { id: room.id, name: room.name || 'Room', visibility: room.visibility || null }
    });
  } catch {
    return fail(500, 'Could not join room');
  }
};

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { isUuid, cleanText, requireOneOf } from '../lib/validation';
import { logSecurityEvent } from '../lib/logger';
import { countRecentEvents, rateLimitResponse } from '../lib/rate-limit';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const ALLOWED_REASONS = ['spam', 'harassment', 'hate', 'impersonation', 'nsfw', 'other'] as const;
const REPORT_RATE_LIMIT_MAX = 10;
const REPORT_RATE_LIMIT_WINDOW = 60 * 60 * 1000;

interface MessageRow { id: string; user_id: string; room_id: string }

function dmUsers(roomId: string): [string, string] | null {
  const m = String(roomId || '').match(/^dm_([0-9a-f-]{36})_([0-9a-f-]{36})$/i);
  return m && m[1] && m[2] ? [m[1], m[2]] : null;
}

function isPublicAppRoom(roomId: string): boolean {
  const v = String(roomId || '');
  return v === 'general' || (!v.startsWith('custom_') && !v.startsWith('dm_') && !isUuid(v));
}

async function canAccessRoom(userId: string, roomId: string, serviceKey: string): Promise<boolean> {
  if (!roomId) return false;
  if (isPublicAppRoom(roomId)) return true;
  const dm = dmUsers(roomId);
  if (dm) return dm.includes(userId);
  const membershipRoomId = roomId.startsWith('custom_') ? roomId.slice(7) : roomId;
  if (!isUuid(membershipRoomId)) return false;
  const res = await supaRequest<unknown[]>(
    'GET',
    'room_members?room_id=eq.' + encodeURIComponent(membershipRoomId) +
      '&user_id=eq.' + encodeURIComponent(userId) +
      '&select=id&limit=1',
    null, serviceKey
  );
  return Array.isArray(res.body) && res.body.length > 0;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid body');
  } catch { return fail(400, 'Invalid body'); }

  try {
    const reportCount = await countRecentEvents(serviceKey, user.id, 'chat_report_submitted', REPORT_RATE_LIMIT_WINDOW);
    if (reportCount >= REPORT_RATE_LIMIT_MAX) {
      await logSecurityEvent(serviceKey, user.id, 'chat_report_rate_limited', { count: reportCount });
      return rateLimitResponse(REPORT_RATE_LIMIT_WINDOW, 'Report limit reached. Please try again later.');
    }

    const reason = requireOneOf(
      String(body.reason || '').trim().toLowerCase(),
      ALLOWED_REASONS, 'Reason'
    );
    const details = body.details ? cleanText(body.details, 1000) : '';
    const messageId = typeof body.messageId === 'string' && isUuid(body.messageId) ? body.messageId : null;
    let roomId = body.roomId ? cleanText(body.roomId, 128) : '';
    let reportedUserId = typeof body.reportedUserId === 'string' && isUuid(body.reportedUserId)
      ? body.reportedUserId : null;

    if (!messageId && !roomId && !reportedUserId) {
      return fail(400, 'A message, room, or reported user is required');
    }

    if (messageId) {
      const msgRes = await supaRequest<MessageRow[]>(
        'GET',
        'messages?id=eq.' + encodeURIComponent(messageId) + '&select=id,user_id,room_id&limit=1',
        null, serviceKey
      );
      const msg = Array.isArray(msgRes.body) ? msgRes.body[0] : null;
      if (!msg || !msg.id) return fail(404, 'Message not found');
      roomId = msg.room_id || roomId;
      reportedUserId = msg.user_id || reportedUserId;
    }

    if (reportedUserId === user.id) return fail(400, 'You cannot report yourself');

    if (roomId) {
      const allowed = await canAccessRoom(user.id, roomId, serviceKey);
      if (!allowed) return fail(403, 'Not allowed in this room');
    }

    const insertRes = await supaRequest('POST', 'chat_reports',
      {
        reporter_id: user.id,
        reported_user_id: reportedUserId,
        message_id: messageId,
        room_id: roomId || null,
        reason,
        details: details || null,
        status: 'open',
        created_at: new Date().toISOString()
      },
      serviceKey, { Prefer: 'return=minimal' }
    );
    if (insertRes.status < 200 || insertRes.status >= 300) return fail(500, 'Could not submit report');

    await logSecurityEvent(serviceKey, user.id, 'chat_report_submitted', {
      reason, message_id: messageId, room_id: roomId || null, reported_user_id: reportedUserId || null
    });
    return jsonResponse(200, { ok: true });
  } catch {
    return fail(400, 'Invalid report');
  }
};

import { requireEnv, optionalEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { supaRequest } from '../lib/supabase-admin';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { logSecurityEvent } from '../lib/logger';
import { isUuid, cleanText } from '../lib/validation';
import { countRecentMessages, rateLimitResponse } from '../lib/rate-limit';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const CHAT_RATE_LIMIT_MAX    = parseInt(optionalEnv('CHAT_RATE_LIMIT_MAX',       '30'), 10);
const CHAT_RATE_LIMIT_WINDOW = parseInt(optionalEnv('CHAT_RATE_LIMIT_WINDOW_MS', String(60 * 1000)), 10);

function dmUsers(roomId: string): [string, string] | null {
  const match = String(roomId || '').match(/^dm_([0-9a-f-]{36})_([0-9a-f-]{36})$/i);
  return match && match[1] && match[2] ? [match[1], match[2]] : null;
}

function isPublicAppRoom(roomId: string): boolean {
  const value = String(roomId || '');
  return value === 'general' ||
    (!value.startsWith('custom_') && !value.startsWith('dm_') && !isUuid(value));
}

async function usersBlockedEachOther(userId: string, otherId: string, serviceKey: string): Promise<boolean> {
  const path =
    'blocked_users?or=(and(blocker_id.eq.' + encodeURIComponent(userId) +
    ',blocked_id.eq.' + encodeURIComponent(otherId) +
    '),and(blocker_id.eq.' + encodeURIComponent(otherId) +
    ',blocked_id.eq.' + encodeURIComponent(userId) +
    '))&select=id&limit=1';
  const res = await supaRequest<unknown[]>('GET', path, null, serviceKey);
  return Array.isArray(res.body) && res.body.length > 0;
}

async function userCanSendToRoom(userId: string, roomId: string, serviceKey: string): Promise<boolean> {
  if (isPublicAppRoom(roomId)) return true;
  const dm = dmUsers(roomId);
  if (dm) {
    if (!dm.includes(userId)) return false;
    const otherId = dm[0] === userId ? dm[1] : dm[0];
    if (await usersBlockedEachOther(userId, otherId, serviceKey)) return false;
    const path =
      'friendships?or=(and(user_id.eq.' + encodeURIComponent(userId) +
      ',friend_id.eq.' + encodeURIComponent(otherId) +
      '),and(user_id.eq.' + encodeURIComponent(otherId) +
      ',friend_id.eq.' + encodeURIComponent(userId) +
      '))&status=eq.accepted&select=id&limit=1';
    const res = await supaRequest<unknown[]>('GET', path, null, serviceKey);
    return Array.isArray(res.body) && res.body.length > 0;
  }
  const membershipRoomId = roomId.startsWith('custom_') ? roomId.slice(7) : roomId;
  if (!isUuid(membershipRoomId)) return false;
  const path = 'room_members?room_id=eq.' + encodeURIComponent(membershipRoomId) +
    '&user_id=eq.' + encodeURIComponent(userId) + '&select=id&limit=1';
  const res = await supaRequest<unknown[]>('GET', path, null, serviceKey);
  return Array.isArray(res.body) && res.body.length > 0;
}

interface MessagePayload {
  room_id: string;
  user_id: string;
  display_name: string;
  content: string;
  attachment_url?: string;
  attachment_type?: string;
  attachment_name?: string;
  reply_to_id?: string;
  mentions?: string[];
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired session');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid body');
  } catch { return fail(400, 'Invalid body'); }

  const roomId         = cleanText(body.room_id, 128);
  const content        = cleanText(body.content, 4000);
  const attachmentUrl  = cleanText(body.attachment_url, 1024);
  const attachmentType = cleanText(body.attachment_type, 80);
  const attachmentName = cleanText(body.attachment_name, 255);
  const displayName    = cleanText(body.display_name, 80) || 'Student';

  if (!roomId) return fail(400, 'Missing room_id');
  if (!content && !attachmentUrl) return fail(400, 'Message is empty');
  if (body.reply_to_id && !isUuid(body.reply_to_id)) return fail(400, 'Invalid reply_to_id');
  if (Object.prototype.hasOwnProperty.call(body, 'mentions') && !Array.isArray(body.mentions)) {
    return fail(400, 'mentions must be an array');
  }

  try {
    const msgCount = await countRecentMessages(serviceKey, user.id, CHAT_RATE_LIMIT_WINDOW);
    if (msgCount >= CHAT_RATE_LIMIT_MAX) {
      await logSecurityEvent(serviceKey, user.id, 'chat_rate_limited', { room_id: roomId, count: msgCount });
      return rateLimitResponse(CHAT_RATE_LIMIT_WINDOW, 'You are sending messages too quickly. Please wait a moment.');
    }
    const canSend = await userCanSendToRoom(user.id, roomId, serviceKey);
    if (!canSend) {
      await logSecurityEvent(serviceKey, user.id, 'chat_send_denied', { room_id: roomId });
      return fail(403, 'Not allowed in this room');
    }

    const payload: MessagePayload = { room_id: roomId, user_id: user.id, display_name: displayName, content };
    if (attachmentUrl) {
      payload.attachment_url = attachmentUrl;
      payload.attachment_type = attachmentType || 'file';
      payload.attachment_name = attachmentName || 'Attachment';
    }
    if (typeof body.reply_to_id === 'string') payload.reply_to_id = body.reply_to_id;
    if (Array.isArray(body.mentions)) {
      payload.mentions = (body.mentions as unknown[])
        .slice(0, 20)
        .map((m) => cleanText(m, 80))
        .filter(Boolean);
    }

    const insertRes = await supaRequest('POST', 'messages', payload, serviceKey, { Prefer: 'return=minimal' });
    if (insertRes.status < 200 || insertRes.status >= 300) return fail(500, 'Could not send message');
    return jsonResponse(200, { ok: true });
  } catch {
    return fail(500, 'Could not send message');
  }
};

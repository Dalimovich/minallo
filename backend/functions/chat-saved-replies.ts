// /api/chat-saved-replies — durable copy of the chatbot's "Save to notes" replies.
//
// The client is offline-first: replies are written to localStorage immediately
// and pushed here in the background, so POST is an UPSERT keyed on the
// client-generated id (re-pushing after a failed/duplicate sync must be a
// no-op, not an error).

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const MAX_REPLY_CHARS = 80000; // matches NCB_MAX_STORED_MESSAGE_CHARS + DB check
const MAX_ID_CHARS = 64;

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const params = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    let path = 'chat_saved_replies?select=id,chat_id,reply_text,created_at' +
      '&user_id=eq.' + encodeURIComponent(user.id) +
      '&order=created_at.desc&limit=200';
    if (params.chatId) path += '&chat_id=eq.' + encodeURIComponent(params.chatId);
    const result = await supaRequest<unknown[]>('GET', path, null, serviceKey)
      .catch(() => ({ status: 0, body: [] as unknown[] }));
    const rows = Array.isArray(result.body) ? result.body : [];
    return jsonResponse(200, { replies: rows });
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
    catch { return fail(400, 'Invalid JSON'); }

    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!id || id.length > MAX_ID_CHARS) return fail(400, 'id is required');
    if (!chatId || chatId.length > MAX_ID_CHARS) return fail(400, 'chatId is required');
    if (!text.trim()) return fail(400, 'text is required');

    const createdAtMs = typeof body.createdAt === 'number' ? body.createdAt : Date.now();
    const row = {
      user_id: user.id,
      id,
      chat_id: chatId,
      reply_text: text.slice(0, MAX_REPLY_CHARS),
      created_at: new Date(createdAtMs).toISOString()
    };
    const result = await supaRequest(
      'POST',
      'chat_saved_replies?on_conflict=user_id,id',
      row,
      serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
    if (result.status < 200 || result.status >= 300) {
      return fail(502, 'Could not save reply');
    }
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const id = params.id;
    if (!id) return fail(400, 'id is required');
    await supaRequest('DELETE',
      'chat_saved_replies?id=eq.' + encodeURIComponent(id) +
      '&user_id=eq.' + encodeURIComponent(user.id),
      null, serviceKey, { Prefer: 'return=minimal' });
    return jsonResponse(200, { ok: true });
  }

  return fail(405, 'Method not allowed');
};

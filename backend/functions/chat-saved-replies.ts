// /api/chat-saved-replies — durable copy of the chatbot's "Save to notes" replies.
//
// The client is offline-first: replies are written to localStorage immediately
// and pushed here in the background, so POST is an UPSERT keyed on the
// client-generated id (re-pushing after a failed/duplicate sync must be a
// no-op, not an error).

import { createHash } from 'crypto';
import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const MAX_REPLY_CHARS = 80000; // matches NCB_MAX_STORED_MESSAGE_CHARS + DB check
const MAX_ID_CHARS = 64;
const MAX_COURSE_ID_CHARS = 200;
const MAX_PROMPT_CHARS = 1000;
const MAX_PAGE_SIZE = 200;

export function normalizeSavedReplyText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function savedReplyFingerprint(text: string): string {
  return createHash('sha256').update(normalizeSavedReplyText(text), 'utf8').digest('hex');
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const params = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    const SELECT = 'select=id,chat_id,reply_text,created_at,course_id,source_message_id,source_prompt,content_fingerprint';

    // Exact single-row lookup, independent of the paginated listing below —
    // a response older than the caller's loaded pages must still resolve by
    // id (e.g. re-opening a bookmark from a stale in-memory reference).
    if (params.id) {
      const path = 'chat_saved_replies?' + SELECT +
        '&user_id=eq.' + encodeURIComponent(user.id) +
        '&id=eq.' + encodeURIComponent(params.id) + '&limit=1';
      const result = await supaRequest<unknown[]>('GET', path, null, serviceKey)
        .catch(() => ({ status: 0, body: [] as unknown[] }));
      if (result.status < 200 || result.status >= 300) {
        return fail(502, 'Could not load saved AI response');
      }
      const rows = Array.isArray(result.body) ? result.body : [];
      return jsonResponse(200, { replies: rows });
    }

    // Keyset-stable offset pagination: (created_at desc, id desc) is a total
    // order (id breaks ties within the same millisecond), so a fixed `limit`
    // with an increasing `offset` never skips or repeats a row across pages.
    // A single unpaginated request used to hard-cap the whole account's
    // saved responses at 200 — anything older was permanently unreachable.
    const requestedLimit = Number.parseInt(params.limit || '', 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_PAGE_SIZE)
      : MAX_PAGE_SIZE;
    const requestedOffset = Number.parseInt(params.offset || '', 10);
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

    let path = 'chat_saved_replies?' + SELECT +
      '&user_id=eq.' + encodeURIComponent(user.id) +
      '&order=created_at.desc,id.desc&limit=' + limit + '&offset=' + offset;
    if (params.chatId) path += '&chat_id=eq.' + encodeURIComponent(params.chatId);
    const result = await supaRequest<unknown[]>('GET', path, null, serviceKey)
      .catch(() => ({ status: 0, body: [] as unknown[] }));
    // A query/schema failure must not read as "zero saved responses" — the
    // client falls back to its local cache on a non-2xx response, but on a
    // fake 200 it trusts the empty list and hides bookmarks that do exist.
    if (result.status < 200 || result.status >= 300) {
      return fail(502, 'Could not load saved AI responses');
    }
    const rows = Array.isArray(result.body) ? result.body : [];
    const nextOffset = rows.length === limit ? offset + rows.length : null;
    return jsonResponse(200, { replies: rows, nextOffset });
  }

  if (event.httpMethod === 'POST') {
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
    catch { return fail(400, 'Invalid JSON'); }

    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const courseId = typeof body.courseId === 'string' && body.courseId.trim() ? body.courseId.trim() : null;
    const sourceMessageId = typeof body.sourceMessageId === 'string' && body.sourceMessageId.trim() ? body.sourceMessageId.trim() : null;
    const sourcePrompt = typeof body.sourcePrompt === 'string' && body.sourcePrompt.trim() ? body.sourcePrompt.trim().slice(0, MAX_PROMPT_CHARS) : null;
    if (!id || id.length > MAX_ID_CHARS) return fail(400, 'id is required');
    if (!chatId || chatId.length > MAX_ID_CHARS) return fail(400, 'chatId is required');
    if (!text.trim()) return fail(400, 'text is required');
    if (courseId && courseId.length > MAX_COURSE_ID_CHARS) return fail(400, 'courseId is too long');
    if (sourceMessageId && sourceMessageId.length > MAX_ID_CHARS) return fail(400, 'sourceMessageId is too long');

    const normalizedText = normalizeSavedReplyText(text).slice(0, MAX_REPLY_CHARS);
    const fingerprint = savedReplyFingerprint(normalizedText);
    const sourceQuery = sourceMessageId
      ? 'chat_saved_replies?select=id&user_id=eq.' + encodeURIComponent(user.id) + '&source_message_id=eq.' + encodeURIComponent(sourceMessageId) + '&limit=1'
      : null;
    const scopeFilter = courseId
      ? '&course_id=eq.' + encodeURIComponent(courseId)
      : '&course_id=is.null';
    const fingerprintQuery = 'chat_saved_replies?select=id&user_id=eq.' + encodeURIComponent(user.id) + scopeFilter +
      '&content_fingerprint=eq.' + encodeURIComponent(fingerprint) + '&limit=1';
    for (const query of [sourceQuery, fingerprintQuery]) {
      if (!query) continue;
      const existing = await supaRequest<Array<{ id?: string }>>('GET', query, null, serviceKey);
      const existingId = Array.isArray(existing.body) ? existing.body[0]?.id : undefined;
      if (existingId) return jsonResponse(200, { ok: true, duplicate: true, existingId });
    }

    const createdAtMs = typeof body.createdAt === 'number' ? body.createdAt : Date.now();
    const row = {
      user_id: user.id,
      id,
      chat_id: chatId,
      reply_text: normalizedText,
      course_id: courseId,
      source_message_id: sourceMessageId,
      source_prompt: sourcePrompt,
      content_fingerprint: fingerprint,
      created_at: new Date(createdAtMs).toISOString()
    };
    const result = await supaRequest(
      'POST',
      'chat_saved_replies?on_conflict=user_id,id',
      row,
      serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
    if (result.status === 409) {
      // Either unique constraint could have fired the conflict (a concurrent
      // request from another tab can collide on the fingerprint even when
      // sourceMessageId differs), so check both instead of assuming the one
      // this request happened to prefer.
      const [sourceExisting, fingerprintExisting] = await Promise.all([
        sourceQuery ? supaRequest<Array<{ id?: string }>>('GET', sourceQuery, null, serviceKey) : Promise.resolve(null),
        supaRequest<Array<{ id?: string }>>('GET', fingerprintQuery, null, serviceKey),
      ]);
      const existingId =
        (Array.isArray(sourceExisting?.body) ? sourceExisting.body[0]?.id : undefined)
        || (Array.isArray(fingerprintExisting.body) ? fingerprintExisting.body[0]?.id : undefined);
      if (!existingId) {
        // The DB reports a conflict but neither re-query can identify the
        // conflicting row (e.g. it was deleted between the insert attempt
        // and this lookup). Returning ok:true here would mark the local
        // copy durably synced when we don't actually know which — if any —
        // server row backs it. Fail so the client keeps retrying instead.
        return fail(409, 'Could not resolve saved reply conflict');
      }
      return jsonResponse(200, { ok: true, duplicate: true, existingId });
    }
    if (result.status < 200 || result.status >= 300) {
      return fail(502, 'Could not save reply');
    }
    return jsonResponse(200, { ok: true, duplicate: false, id });
  }

  if (event.httpMethod === 'DELETE') {
    const id = params.id;
    if (!id) return fail(400, 'id is required');
    const result = await supaRequest('DELETE',
      'chat_saved_replies?id=eq.' + encodeURIComponent(id) +
      '&user_id=eq.' + encodeURIComponent(user.id),
      null, serviceKey, { Prefer: 'return=minimal' });
    // A failed database deletion must not look successful — the client
    // clears its local pending-delete tombstone only on a genuine {ok:true},
    // so a fake success here would let a row the user deleted survive
    // server-side forever with nothing left to retry it.
    if (result.status < 200 || result.status >= 300) {
      return fail(502, 'Could not delete saved reply');
    }
    return jsonResponse(200, { ok: true });
  }

  return fail(405, 'Method not allowed');
};

// POST /api/ai/quiz-attempt — record a batch of quiz answers for a course.
//
// Body: { courseId: string, items: [{ topic: string, correct: boolean }, ...] }
//
// Behaviour:
//   • Verify JWT + active subscription.
//   • Filter out items whose topic isn't a known primary_topic for this course
//     (anti-pollution: clients can't write arbitrary strings to their mastery).
//   • Upsert one row per (user, course, topic): attempts += n, correct += k,
//     mastery_score = (correct + 1) / (attempts + 2)  (Laplace smoothing).
//   • Return the updated rows for this course so the UI can re-render without
//     a second fetch.
//
// Mastery is the durable backing for Phase 2 (dashboard panel) and Phase 3
// (tutor system-prompt injection). Keep this endpoint cheap: pure DB writes,
// no AI calls. Pricing-wise this counts under the interactive bucket so a
// student attempting quizzes doesn't burn through their generation cap.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const MAX_ITEMS = 50;
const MAX_TOPIC_LENGTH = 200;

interface AttemptItem { topic: string; correct: boolean }
interface MasteryRow {
  user_id: string;
  course_id: string;
  topic: string;
  attempts: number;
  correct: number;
  mastery_score: number;
  last_practiced_at: string | null;
  updated_at?: string;
}

function _smooth(correct: number, attempts: number): number {
  if (attempts <= 0) return 0;
  return (correct + 1) / (attempts + 2);
}

async function _knownTopics(
  serviceKey: string, courseId: string
): Promise<Set<string>> {
  const path =
    'document_chunks?course_id=eq.' + encodeURIComponent(courseId) +
    '&primary_topic=not.is.null&select=primary_topic';
  const res = await supaRequest<{ primary_topic: string }[]>('GET', path, null, serviceKey);
  const rows = Array.isArray(res.body) ? res.body : [];
  const out = new Set<string>();
  for (const r of rows) if (r && r.primary_topic) out.add(r.primary_topic);
  return out;
}

async function _fetchRows(
  serviceKey: string, userId: string, courseId: string, topics: string[]
): Promise<Record<string, MasteryRow>> {
  if (!topics.length) return {};
  const inList = topics.map(encodeURIComponent).join(',');
  const path =
    'user_topic_mastery?user_id=eq.' + encodeURIComponent(userId) +
    '&course_id=eq.' + encodeURIComponent(courseId) +
    '&topic=in.(' + inList + ')' +
    '&select=*';
  const res = await supaRequest<MasteryRow[]>('GET', path, null, serviceKey);
  const out: Record<string, MasteryRow> = {};
  for (const r of (Array.isArray(res.body) ? res.body : [])) out[r.topic] = r;
  return out;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_quiz_attempt');
  if (subBlocked) return subBlocked;

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const courseId = body.courseId;
  const rawItems = body.items;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (!Array.isArray(rawItems)) return fail(400, 'items must be an array');
  if (rawItems.length === 0) return fail(400, 'items is empty');
  if (rawItems.length > MAX_ITEMS) return fail(400, 'too many items in one request');

  // Coerce + light validation.
  const items: AttemptItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.topic !== 'string') continue;
    const t = r.topic.trim();
    if (!t || t.length > MAX_TOPIC_LENGTH) continue;
    items.push({ topic: t, correct: !!r.correct });
  }
  if (!items.length) {
    // No usable items — return current mastery so the UI can still render.
    const rows = await supaRequest<MasteryRow[]>(
      'GET',
      'user_topic_mastery?user_id=eq.' + encodeURIComponent(user.id) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&select=*&order=mastery_score.asc',
      null, serviceKey
    );
    return jsonResponse(200, { mastery: Array.isArray(rows.body) ? rows.body : [], updated: [] });
  }

  // Reject topics the client made up. Keeps the table clean and prevents a
  // malicious client from spamming arbitrary strings into their own rows.
  const known = await _knownTopics(serviceKey, courseId);
  const validItems = items.filter((it) => known.has(it.topic));
  const droppedCount = items.length - validItems.length;

  // Aggregate per-topic deltas first so we do one upsert per topic, not one per item.
  const deltas: Record<string, { attempts: number; correct: number }> = {};
  for (const it of validItems) {
    const d = deltas[it.topic] || { attempts: 0, correct: 0 };
    d.attempts += 1;
    if (it.correct) d.correct += 1;
    deltas[it.topic] = d;
  }
  const touchedTopics = Object.keys(deltas);

  const existing = await _fetchRows(serviceKey, user.id, courseId, touchedTopics);
  const nowIso = new Date().toISOString();
  const upsertRows: MasteryRow[] = touchedTopics.map((topic) => {
    const prev = existing[topic];
    const attempts = (prev?.attempts || 0) + deltas[topic]!.attempts;
    const correct = (prev?.correct || 0) + deltas[topic]!.correct;
    return {
      user_id: user.id,
      course_id: courseId,
      topic,
      attempts,
      correct,
      mastery_score: _smooth(correct, attempts),
      last_practiced_at: nowIso,
      updated_at: nowIso
    };
  });

  if (upsertRows.length) {
    const res = await supaRequest(
      'POST',
      'user_topic_mastery',
      upsertRows,
      serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=representation' }
    );
    if (res.status >= 300) {
      // eslint-disable-next-line no-console
      console.error('quiz-attempt upsert failed', res.status, res.body);
      return fail(500, 'Failed to record quiz attempt');
    }
  }

  await logSecurityEvent(serviceKey, user.id, 'ai_quiz_attempt', {
    course_id: courseId,
    item_count: items.length,
    accepted: validItems.length,
    dropped: droppedCount,
    topics: touchedTopics.length
  }).catch(() => undefined);

  // Return the full mastery snapshot for this course so the UI can re-render
  // without a second round-trip. Sorted weakest-first to match the panel.
  const rows = await supaRequest<MasteryRow[]>(
    'GET',
    'user_topic_mastery?user_id=eq.' + encodeURIComponent(user.id) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=*&order=mastery_score.asc',
    null, serviceKey
  );

  return jsonResponse(200, {
    mastery: Array.isArray(rows.body) ? rows.body : [],
    updated: upsertRows.map((r) => r.topic),
    dropped: droppedCount
  });
};

// GET/PATCH /api/study/done-files
//
// Manages the user's set of "already studied" course files. Marking a file done
// records it in student_document_state AND flips the topics that file covers to
// progress_state='studied' in student_topic_state — the same signal the planner
// reads after a study task is completed. The planner therefore stops listing the
// file's material as NEW and surfaces it for spaced repetition instead. No
// planner change is required (see migration 20260610_000001).

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, requireStudyAuth, validateCourseId, writeStudyEvent } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;

  if (event.httpMethod === 'GET') {
    const courseId = validateCourseId(courseIdFromQuery(event));
    if (typeof courseId !== 'string') return courseId;
    const res = await supaRequest<Array<{ document_id: string }>>(
      'GET',
      'student_document_state?user_id=eq.' + encodeURIComponent(auth.user.id) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&status=eq.done&select=document_id',
      null,
      auth.serviceKey
    );
    const documentIds = (Array.isArray(res.body) ? res.body : []).map((r) => r.document_id);
    return jsonResponse(200, { documentIds });
  }

  if (event.httpMethod !== 'PATCH') return fail(405, 'Method not allowed');

  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;

  const courseId = validateCourseId(data.courseId);
  if (typeof courseId !== 'string') return courseId;

  const documentIds = Array.isArray(data.documentIds)
    ? [...new Set(data.documentIds.map((d) => String(d)).filter(Boolean))]
    : null;
  if (!documentIds) return fail(400, 'documentIds array is required');

  const now = new Date().toISOString();

  // Current done set for this course.
  const currentRes = await supaRequest<Array<{ document_id: string }>>(
    'GET',
    'student_document_state?user_id=eq.' + encodeURIComponent(auth.user.id) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&status=eq.done&select=document_id',
    null,
    auth.serviceKey
  );
  const current = new Set((Array.isArray(currentRes.body) ? currentRes.body : []).map((r) => r.document_id));
  const next = new Set(documentIds);
  const newlyDone = documentIds.filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !next.has(id));

  // Upsert the new done set. on_conflict targets the (user_id, document_id)
  // unique key — without it PostgREST resolves on the PK (id, which defaults to
  // a fresh uuid), so re-saving an already-marked file hits a duplicate-key error
  // instead of merging.
  if (documentIds.length > 0) {
    await supaRequest(
      'POST',
      'student_document_state?on_conflict=user_id,document_id',
      documentIds.map((document_id) => ({
        user_id: auth.user.id,
        course_id: courseId,
        document_id,
        status: 'done',
        marked_done_at: now,
        updated_at: now,
      })),
      auth.serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
  }

  // Remove unchecked files.
  if (removed.length > 0) {
    await supaRequest(
      'DELETE',
      'student_document_state?user_id=eq.' + encodeURIComponent(auth.user.id) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&document_id=in.(' + removed.map((id) => encodeURIComponent(id)).join(',') + ')',
      null,
      auth.serviceKey,
      { Prefer: 'return=minimal' }
    );
    // Unchecking should make the planner see the file as new material again, so
    // revert its covered topics from 'studied' → 'not_started'. Conservative: a
    // topic is only reverted when NO still-done file covers it and it's merely
    // 'studied' (never 'practiced'/'mastered', which reflect deeper progress the
    // user actually earned via quizzes/practice, not a file mark).
    await revertUnmarkedFileTopics(auth.user.id, courseId, removed, [...next], auth.serviceKey)
      .catch((err) => console.error('[study-done-files] topic revert failed:', err));
  }

  // For newly-marked files, flip their covered topics to 'studied' so the planner
  // treats them as known material (spaced repetition), not new lectures.
  let topicsMarked = 0;
  let topicWriteOk = true;
  let filesWithoutTopics: string[] = [];
  if (newlyDone.length > 0) {
    const res = await markFileTopicsStudied(auth.user.id, courseId, newlyDone, now, auth.serviceKey);
    topicsMarked = res.topicsMarked;
    topicWriteOk = res.ok;
    filesWithoutTopics = res.filesWithoutTopics;
    await writeStudyEvent(auth.serviceKey, {
      user_id: auth.user.id,
      course_id: courseId,
      event_type: 'files_marked_done',
      metadata: { documentIds: newlyDone, topicsMarked, topicWriteOk, filesWithoutTopics },
    }).catch(() => undefined);
  }

  // `topicWriteOk` lets the client know the planner-facing write actually landed —
  // a file with no topic-map links (filesWithoutTopics) is saved but won't change
  // planner behaviour until its course topic map is built.
  return jsonResponse(200, { documentIds: [...next], topicsMarked, topicWriteOk, filesWithoutTopics });
};

interface TopicMarkResult {
  topicsMarked: number;
  ok: boolean;
  filesWithoutTopics: string[];
}

// Map done documents → the topics they cover (via course_topics.source_document_ids)
// → upsert student_topic_state(progress_state='studied'). Mirrors the topic-state
// write study-task.ts performs when a learning task is completed.
//
// on_conflict targets the live (user_id, topic_id) unique key — required for the
// merge to actually update an existing row instead of failing on duplicate key.
// Unlike study-task.ts (which swallows this write's error), we surface failure so
// the caller can tell the UI the planner-facing write didn't land.
async function markFileTopicsStudied(
  userId: string,
  courseId: string,
  documentIds: string[],
  now: string,
  serviceKey: string
): Promise<TopicMarkResult> {
  const topicsRes = await supaRequest<Array<{ id: string; source_document_ids: unknown }>>(
    'GET',
    'course_topics?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,source_document_ids',
    null,
    serviceKey
  );
  const topics = Array.isArray(topicsRes.body) ? topicsRes.body : [];

  // Which of the done files actually map to at least one topic? Files with no
  // topic-map link can't change planner behaviour — report them back.
  const docsWithTopics = new Set<string>();
  const topicIds = new Set<string>();
  for (const t of topics) {
    const docs = Array.isArray(t.source_document_ids) ? t.source_document_ids : [];
    const hit = docs.map((d) => String(d)).filter((d) => documentIds.includes(d));
    if (hit.length) {
      topicIds.add(t.id);
      hit.forEach((d) => docsWithTopics.add(d));
    }
  }
  const filesWithoutTopics = documentIds.filter((d) => !docsWithTopics.has(d));

  if (topicIds.size === 0) {
    return { topicsMarked: 0, ok: true, filesWithoutTopics };
  }

  try {
    await supaRequest(
      'POST',
      'student_topic_state?on_conflict=user_id,topic_id',
      [...topicIds].map((topic_id) => ({
        user_id: userId,
        course_id: courseId,
        topic_id,
        progress_state: 'studied',
        last_studied_at: now,
        study_sessions: 1,
      })),
      serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
    return { topicsMarked: topicIds.size, ok: true, filesWithoutTopics };
  } catch (err) {
    console.error('[study-done-files] topic-state upsert failed:', err);
    return { topicsMarked: 0, ok: false, filesWithoutTopics };
  }
}

// Revert topics covered ONLY by now-unchecked files back to 'not_started', so the
// planner reintroduces that material as new. Topics still covered by another
// done file, or already advanced past 'studied', are left untouched.
async function revertUnmarkedFileTopics(
  userId: string,
  courseId: string,
  removedDocs: string[],
  stillDoneDocs: string[],
  serviceKey: string
): Promise<void> {
  const topicsRes = await supaRequest<Array<{ id: string; source_document_ids: unknown }>>(
    'GET',
    'course_topics?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,source_document_ids',
    null,
    serviceKey
  );
  const topics = Array.isArray(topicsRes.body) ? topicsRes.body : [];
  const removedSet = new Set(removedDocs);
  const stillDoneSet = new Set(stillDoneDocs);

  const toRevert: string[] = [];
  for (const t of topics) {
    const docs = Array.isArray(t.source_document_ids) ? t.source_document_ids.map((d) => String(d)) : [];
    const coveredByRemoved = docs.some((d) => removedSet.has(d));
    if (!coveredByRemoved) continue;
    const coveredByStillDone = docs.some((d) => stillDoneSet.has(d));
    if (!coveredByStillDone) toRevert.push(t.id);
  }
  if (toRevert.length === 0) return;

  await supaRequest(
    'PATCH',
    'student_topic_state?user_id=eq.' + encodeURIComponent(userId) +
      '&progress_state=eq.studied' +
      '&topic_id=in.(' + toRevert.map((id) => encodeURIComponent(id)).join(',') + ')',
    { progress_state: 'not_started', last_studied_at: null },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
}

function courseIdFromQuery(event: NetlifyEvent): string | null {
  const q = event.queryStringParameters;
  if (q && typeof q.courseId === 'string') return q.courseId;
  const match = String(event.path || '').match(/[?&]courseId=([^&]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

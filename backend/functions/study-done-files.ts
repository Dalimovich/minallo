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

  // Upsert the new done set.
  if (documentIds.length > 0) {
    await supaRequest(
      'POST',
      'student_document_state',
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
  }

  // For newly-marked files, flip their covered topics to 'studied' so the planner
  // treats them as known material (spaced repetition), not new lectures.
  let topicsMarked = 0;
  if (newlyDone.length > 0) {
    topicsMarked = await markFileTopicsStudied(auth.user.id, courseId, newlyDone, now, auth.serviceKey);
    await writeStudyEvent(auth.serviceKey, {
      user_id: auth.user.id,
      course_id: courseId,
      event_type: 'files_marked_done',
      metadata: { documentIds: newlyDone, topicsMarked },
    }).catch(() => undefined);
  }

  return jsonResponse(200, { documentIds: [...next], topicsMarked });
};

// Map done documents → the topics they cover (via course_topics.source_document_ids)
// → upsert student_topic_state(progress_state='studied'). Mirrors the topic-state
// write study-task.ts performs when a learning task is completed.
async function markFileTopicsStudied(
  userId: string,
  courseId: string,
  documentIds: string[],
  now: string,
  serviceKey: string
): Promise<number> {
  const topicsRes = await supaRequest<Array<{ id: string; source_document_ids: unknown }>>(
    'GET',
    'course_topics?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,source_document_ids',
    null,
    serviceKey
  );
  const topics = Array.isArray(topicsRes.body) ? topicsRes.body : [];
  const wanted = new Set(documentIds);
  const topicIds = new Set<string>();
  for (const t of topics) {
    const docs = Array.isArray(t.source_document_ids) ? t.source_document_ids : [];
    if (docs.some((d) => wanted.has(String(d)))) topicIds.add(t.id);
  }
  if (topicIds.size === 0) return 0;

  await supaRequest(
    'POST',
    'student_topic_state',
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
  ).catch(() => undefined);

  return topicIds.size;
}

function courseIdFromQuery(event: NetlifyEvent): string | null {
  const q = event.queryStringParameters;
  if (q && typeof q.courseId === 'string') return q.courseId;
  const match = String(event.path || '').match(/[?&]courseId=([^&]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

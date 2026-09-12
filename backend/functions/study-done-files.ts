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
import {
  candidateRevertTopics,
  selectMarkableTopics,
  topicsForDocuments,
  topicsToRevert,
} from '../lib/study-done-files-logic';
import { LEARNING_TASK_TYPES, scheduleRepetition } from './study-task';
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

  // For newly-marked files: (1) flip their covered topics to 'studied' so the
  // planner treats them as known material, and (2) surgically complete the active
  // tasks tied to those files and seed spaced repetition for the learning ones.
  // We deliberately do NOT regenerate the whole plan — regeneration rebuilds every
  // task and can churn the day into an unrelated, ballooned list. Completing just
  // the done-file tasks keeps the rest of the plan intact.
  let topicsMarked = 0;
  let topicWriteOk = true;
  let filesWithoutTopics: string[] = [];
  let tasksCompleted = 0;
  let repetitionsScheduled = 0;
  if (newlyDone.length > 0) {
    const res = await markFileTopicsStudied(auth.user.id, courseId, newlyDone, now, auth.serviceKey);
    topicsMarked = res.topicsMarked;
    topicWriteOk = res.ok;
    filesWithoutTopics = res.filesWithoutTopics;

    const completion = await completeTasksForDoneFiles(auth.user.id, courseId, newlyDone, now, auth.serviceKey)
      .catch((err) => {
        console.error('[study-done-files] task completion failed:', err);
        return { tasksCompleted: 0, repetitionsScheduled: 0 };
      });
    tasksCompleted = completion.tasksCompleted;
    repetitionsScheduled = completion.repetitionsScheduled;

    await writeStudyEvent(auth.serviceKey, {
      user_id: auth.user.id,
      course_id: courseId,
      event_type: 'files_marked_done',
      metadata: { documentIds: newlyDone, topicsMarked, topicWriteOk, filesWithoutTopics, tasksCompleted, repetitionsScheduled },
    }).catch(() => undefined);
  }

  // `topicWriteOk` lets the client know the planner-facing write actually landed —
  // a file with no topic-map links (filesWithoutTopics) is saved but won't change
  // planner behaviour until its course topic map is built.
  return jsonResponse(200, {
    documentIds: [...next],
    topicsMarked,
    topicWriteOk,
    filesWithoutTopics,
    tasksCompleted,
    repetitionsScheduled,
  });
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
  const { topicIds, docsWithTopics } = topicsForDocuments(topics, documentIds);
  const filesWithoutTopics = documentIds.filter((d) => !docsWithTopics.has(d));

  if (topicIds.length === 0) {
    return { topicsMarked: 0, ok: true, filesWithoutTopics };
  }

  // Only write 'studied' onto topics with no row yet or at 'not_started'/
  // 'in_progress'. Topics already 'studied' need no change (and rewriting them
  // would flatten their metadata); anything more advanced (practiced/mastered/
  // weak) must not be downgraded. Fetch current states and filter first — the
  // upsert would otherwise blindly overwrite progress_state back to 'studied'.
  const stateRes = await supaRequest<Array<{ topic_id: string; progress_state: string }>>(
    'GET',
    'student_topic_state?user_id=eq.' + encodeURIComponent(userId) +
      '&topic_id=in.(' + topicIds.map((id) => encodeURIComponent(id)).join(',') + ')' +
      '&select=topic_id,progress_state',
    null,
    serviceKey
  );
  const currentState = new Map(
    (Array.isArray(stateRes.body) ? stateRes.body : []).map((r) => [r.topic_id, String(r.progress_state || '')])
  );
  const writeIds = selectMarkableTopics(topicIds, currentState);

  if (writeIds.length === 0) {
    // Every covered topic is already at or beyond 'studied' — nothing to write.
    return { topicsMarked: 0, ok: true, filesWithoutTopics };
  }

  try {
    await supaRequest(
      'POST',
      'student_topic_state?on_conflict=user_id,topic_id',
      writeIds.map((topic_id) => ({
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
    return { topicsMarked: writeIds.length, ok: true, filesWithoutTopics };
  } catch (err) {
    console.error('[study-done-files] topic-state upsert failed:', err);
    return { topicsMarked: 0, ok: false, filesWithoutTopics };
  }
}

// All weekly_study_tasks columns scheduleRepetition() needs from a completed task.
interface CompletableTask {
  id: string;
  plan_id: string;
  course_id: string;
  subject_name: string | null;
  topic_id: string | null;
  source_file_id: string | null;
  exercise_file_id: string | null;
  solution_file_id: string | null;
  related_lecture_file_id: string | null;
  lecture_topics: string[] | null;
  task_type: string;
  task_title: string | null;
  estimated_minutes: number | null;
  source_confidence: string | null;
  page_range: string | null;
  repetition_stage: number | null;
  repetition_origin_task_id: string | null;
  status: string;
}

const _TASK_FIELDS =
  'id,plan_id,course_id,subject_name,topic_id,source_file_id,exercise_file_id,' +
  'solution_file_id,related_lecture_file_id,lecture_topics,task_type,task_title,' +
  'estimated_minutes,source_confidence,page_range,repetition_stage,' +
  'repetition_origin_task_id,status';

// Complete the active (todo/in_progress) tasks whose worked file — lecture/source,
// exercise, or solution — is a now-done document, and seed spaced repetition for
// the learning ones. This is the "I finished these files" action: it removes their
// tasks from the active plan WITHOUT regenerating, and puts the learning material
// into the same +2/+7/+16 repetition cycle that completing a task normally does.
async function completeTasksForDoneFiles(
  userId: string,
  courseId: string,
  documentIds: string[],
  now: string,
  serviceKey: string
): Promise<{ tasksCompleted: number; repetitionsScheduled: number }> {
  if (documentIds.length === 0) return { tasksCompleted: 0, repetitionsScheduled: 0 };

  const idList = documentIds.map((id) => encodeURIComponent(id)).join(',');
  const orFilter =
    'or=(source_file_id.in.(' + idList + '),' +
    'exercise_file_id.in.(' + idList + '),' +
    'solution_file_id.in.(' + idList + '))';

  const tasksRes = await supaRequest<CompletableTask[]>(
    'GET',
    'weekly_study_tasks?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&status=in.(todo,in_progress)&' + orFilter +
      '&select=' + _TASK_FIELDS,
    null,
    serviceKey
  );
  const tasks = Array.isArray(tasksRes.body) ? tasksRes.body : [];
  if (tasks.length === 0) return { tasksCompleted: 0, repetitionsScheduled: 0 };

  await supaRequest(
    'PATCH',
    'weekly_study_tasks?user_id=eq.' + encodeURIComponent(userId) +
      '&id=in.(' + tasks.map((t) => encodeURIComponent(t.id)).join(',') + ')',
    { status: 'completed', status_changed_at: now, updated_at: now },
    serviceKey,
    { Prefer: 'return=minimal' }
  );

  let repetitionsScheduled = 0;
  for (const t of tasks) {
    if (!LEARNING_TASK_TYPES.has(t.task_type)) continue;
    await scheduleRepetition(serviceKey, userId, t)
      .then(() => { repetitionsScheduled += 1; })
      .catch((err) => console.error('[study-done-files] SR scheduling failed (non-fatal):', err));
  }

  return { tasksCompleted: tasks.length, repetitionsScheduled };
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
  const { ids: candidates, docsById: candidateDocs } = candidateRevertTopics(
    topics,
    new Set(removedDocs),
    new Set(stillDoneDocs)
  );
  if (candidates.length === 0) return;

  // Provenance guard. A candidate topic's 'studied' state may have been earned by
  // actually completing a study task, not just by marking a file done. Two signals:
  //   (a) a 'task_completed' study event carrying this topic_id, and
  //   (b) a completed weekly_study_task whose lecture/source file covers the topic
  //       — AI-planner tasks frequently have topic_id=null, so the event alone
  //       misses them; the file linkage catches those.
  // A topic protected by either signal is never reverted.
  const [eventsRes, completedRes] = await Promise.all([
    supaRequest<Array<{ topic_id: string }>>(
      'GET',
      'study_events?user_id=eq.' + encodeURIComponent(userId) +
        '&event_type=eq.task_completed' +
        '&topic_id=in.(' + candidates.map((id) => encodeURIComponent(id)).join(',') + ')' +
        '&select=topic_id',
      null,
      serviceKey
    ),
    supaRequest<Array<{
      source_file_id: string | null;
      related_lecture_file_id: string | null;
      exercise_file_id: string | null;
      solution_file_id: string | null;
    }>>(
      'GET',
      'weekly_study_tasks?user_id=eq.' + encodeURIComponent(userId) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&status=eq.completed&select=source_file_id,related_lecture_file_id,exercise_file_id,solution_file_id',
      null,
      serviceKey
    ),
  ]);
  const earned = new Set((Array.isArray(eventsRes.body) ? eventsRes.body : []).map((r) => r.topic_id));
  // Every file a completed task actually worked on — lecture/source, the paired
  // lecture, the exercise sheet, and the solution sheet — counts as "studied".
  const completedFiles = new Set<string>();
  (Array.isArray(completedRes.body) ? completedRes.body : []).forEach((r) => {
    if (r.source_file_id) completedFiles.add(String(r.source_file_id));
    if (r.related_lecture_file_id) completedFiles.add(String(r.related_lecture_file_id));
    if (r.exercise_file_id) completedFiles.add(String(r.exercise_file_id));
    if (r.solution_file_id) completedFiles.add(String(r.solution_file_id));
  });

  const toRevert = topicsToRevert(candidates, candidateDocs, earned, completedFiles);
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

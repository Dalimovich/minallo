// PATCH /api/study/tasks/:id

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, requireStudyAuth, writeStudyEvent } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const ALLOWED = new Set(['todo', 'in_progress', 'completed', 'skipped', 'moved', 'unavailable', 'replaced']);

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'PATCH') return fail(405, 'Method not allowed');

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;
  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;
  const taskId = taskIdFromPath(event.path);
  if (!taskId) return fail(400, 'Task id is required');
  const status = typeof data.status === 'string' ? data.status : '';
  if (!ALLOWED.has(status)) return fail(400, 'Task status is invalid');

  const currentRes = await supaRequest<Array<{ id: string; user_id: string; course_id: string; topic_id: string | null; status: string }>>(
    'GET',
    'daily_study_tasks?id=eq.' + encodeURIComponent(taskId) +
      '&user_id=eq.' + encodeURIComponent(auth.user.id) +
      '&select=id,user_id,course_id,topic_id,status&limit=1',
    null,
    auth.serviceKey
  );
  const current = Array.isArray(currentRes.body) ? currentRes.body[0] : null;
  if (!current) return fail(404, 'Task not found');
  if (current.status === 'completed' && status !== 'todo') {
    return fail(409, 'Completed tasks can only be manually undone to todo');
  }

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === 'in_progress') patch.started_at = new Date().toISOString();
  if (status === 'completed') patch.completed_at = new Date().toISOString();
  if (status === 'moved' && typeof data.movedToDate === 'string') patch.moved_to_date = data.movedToDate;

  const updated = await supaRequest(
    'PATCH',
    'daily_study_tasks?id=eq.' + encodeURIComponent(taskId) +
      '&user_id=eq.' + encodeURIComponent(auth.user.id),
    patch,
    auth.serviceKey,
    { Prefer: 'return=representation' }
  );
  await writeStudyEvent(auth.serviceKey, {
    user_id: auth.user.id,
    course_id: current.course_id,
    topic_id: current.topic_id,
    task_id: taskId,
    event_type: 'task_' + status,
    value: status,
    metadata: { previousStatus: current.status }
  });
  if (status === 'completed' && current.topic_id) {
    await supaRequest(
      'POST',
      'student_topic_state',
      {
        user_id: auth.user.id,
        course_id: current.course_id,
        topic_id: current.topic_id,
        state: 'reviewed',
        last_task_completed_at: new Date().toISOString(),
        tasks_completed_count: 1
      },
      auth.serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    ).catch(() => undefined);
  }
  return jsonResponse(200, { task: Array.isArray(updated.body) ? updated.body[0] : null });
};

function taskIdFromPath(path: string | undefined): string | null {
  const match = String(path || '').match(/\/api\/study\/tasks\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

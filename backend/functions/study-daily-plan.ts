// GET /api/study/daily-plan?date=YYYY-MM-DD&courseId=...

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import {
  getDailyTasksWithPlan,
  localPlanDate,
  requireStudyAuth,
  validateCourseId,
} from '../lib/study-planner';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;

  const qs = event.queryStringParameters || {};
  const courseId = validateCourseId(qs.courseId);
  if (typeof courseId !== 'string') return courseId;
  const { planDate } = localPlanDate(qs.date, qs.timezone);

  try {
    const { planId, tasks, possibleMatches } = await getDailyTasksWithPlan(
      auth.user.id,
      new Date(planDate + 'T00:00:00Z'),
      auth.serviceKey,
      courseId
    );

    // Transform WeeklyStudyTask → DailyMissionTask (rename fields, add priority_group)
    const formattedTasks = tasks.map((t) => ({
      id: t.id,
      title: t.task_title,
      description: t.task_description,
      task_type: t.task_type,
      priority_group: (t.priority_score ?? 0.5) >= 0.8 ? 'must_do' : (t.priority_score ?? 0.5) >= 0.5 ? 'should_do' : 'optional',
      status: t.status,
      estimated_minutes: t.estimated_minutes,
      page_start: undefined,
      page_end: undefined,
      // Prefer the stored reason from the AI planner; fall back to the synthesized description.
      reason: t.invalidation_reason || t.reason || t.task_description || undefined,
      reason_code: t.invalidation_reason ? 'unavailable' : undefined,
      source_file_id: t.source_file_id,
      source_file_name: t.source_file_name ?? undefined,
      exercise_file_id: t.exercise_file_id,
      exercise_file_name: t.exercise_file_name ?? undefined,
      page_range: t.page_range ?? undefined,
    }));

    const completed = formattedTasks.filter((t) => t.status === 'completed').length;
    const remaining = formattedTasks
      .filter((t) => !['completed', 'replaced'].includes(t.status))
      .reduce((s, t) => s + (t.estimated_minutes || 0), 0);

    return jsonResponse(200, {
      hasPlan: formattedTasks.length > 0,
      planId,
      tasks: formattedTasks,
      possibleMatches,
      summary: {
        completedTasks: completed,
        totalTasks: formattedTasks.length,
        minutesRemaining: remaining,
        status: 'active',
      },
    });
  } catch (err) {
    console.error('[study-daily-plan] Error:', err);
    return fail(500, 'Failed to load daily mission');
  }
};

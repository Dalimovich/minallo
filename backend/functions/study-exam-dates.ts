// GET/PATCH /api/study/exam-dates
// Get or update exam dates for user's courses

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, requireStudyAuth } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;

  if (event.httpMethod === 'GET') {
    // Get all exam dates for user
    const res = await supaRequest(
      'GET',
      'student_subject_state?user_id=eq.' + encodeURIComponent(auth.user.id) + '&select=course_id,exam_date',
      null,
      auth.serviceKey
    );
    const dates = (Array.isArray(res.body) ? res.body : []).reduce((acc: Record<string, string>, row: any) => {
      if (row.exam_date) acc[row.course_id] = row.exam_date;
      return acc;
    }, {});
    return jsonResponse(200, { examDates: dates });
  }

  if (event.httpMethod !== 'PATCH') return fail(405, 'Method not allowed');

  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;

  // data = { courseId: string, examDate: string (YYYY-MM-DD) }
  const courseId = String(data.courseId || '');
  const examDate = String(data.examDate || '');

  if (!courseId || !examDate) {
    return fail(400, 'courseId and examDate required');
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
    return fail(400, 'examDate must be YYYY-MM-DD format');
  }

  try {
    // Upsert exam date in student_subject_state
    const res = await supaRequest(
      'POST',
      'student_subject_state',
      {
        user_id: auth.user.id,
        course_id: courseId,
        exam_date: examDate,
      },
      auth.serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=representation' }
    );
    return jsonResponse(200, { success: true, data: Array.isArray(res.body) ? res.body[0] : null });
  } catch (err) {
    console.error('[study-exam-dates] Error:', err);
    return fail(500, 'Failed to update exam date');
  }
};

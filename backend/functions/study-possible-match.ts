// POST /api/study/possible-match
// Confirm or dismiss a possible exercise↔lecture pairing returned by the AI planner.
//
// Body: { planId, exerciseFileId, possibleLectureFileId, action: "confirm"|"dismiss", planDate? }
//
// On "confirm": inserts a weekly_study_tasks row for the exercise (ignore-duplicates).
// On both actions: removes the entry from weekly_study_plans.possible_matches.
// Returns: { ok: true, remaining: <count> }

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, buildCanonicalTaskKey, requireStudyAuth } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';
import type { PossibleMatch } from '../lib/study-planner-types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;

  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;

  const planId = typeof data.planId === 'string' && data.planId ? data.planId : null;
  const exerciseFileId =
    typeof data.exerciseFileId === 'string' && data.exerciseFileId ? data.exerciseFileId : null;
  const possibleLectureFileId =
    typeof data.possibleLectureFileId === 'string' && data.possibleLectureFileId
      ? data.possibleLectureFileId
      : null;
  const action = data.action === 'confirm' || data.action === 'dismiss' ? data.action : null;
  const planDate =
    typeof data.planDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.planDate)
      ? data.planDate
      : new Date().toISOString().slice(0, 10);

  if (!planId) return fail(400, 'planId is required');
  if (!exerciseFileId) return fail(400, 'exerciseFileId is required');
  if (!possibleLectureFileId) return fail(400, 'possibleLectureFileId is required');
  if (!action) return fail(400, 'action must be "confirm" or "dismiss"');

  // Verify plan belongs to auth.user.id and fetch its possible_matches.
  const planRes = await supaRequest<
    Array<{ id: string; user_id: string; plan_scope: string; course_id: string | null; possible_matches: PossibleMatch[] }>
  >(
    'GET',
    'weekly_study_plans?id=eq.' +
      encodeURIComponent(planId) +
      '&user_id=eq.' +
      encodeURIComponent(auth.user.id) +
      '&select=id,user_id,plan_scope,course_id,possible_matches&limit=1',
    null,
    auth.serviceKey
  );
  const plan = Array.isArray(planRes.body) ? planRes.body[0] ?? null : null;
  if (!plan) return fail(404, 'Plan not found');

  const currentMatches: PossibleMatch[] = Array.isArray(plan.possible_matches)
    ? plan.possible_matches
    : [];

  // Find the matching entry.
  const matchEntry = currentMatches.find(
    (m) => m.exerciseFileId === exerciseFileId && m.possibleLectureFileId === possibleLectureFileId
  );

  // Confirmation integrity: only a pair the planner actually proposed (and that is
  // still pending) may be turned into a task. Without this check the endpoint
  // would trust arbitrary client-submitted ids and schedule an unvetted exercise↔
  // lecture pairing. Dismiss is idempotent, so a missing entry there is harmless.
  if (action === 'confirm' && !matchEntry) {
    return fail(409, 'That pairing is not a pending suggestion for this plan');
  }

  // Role integrity on confirm: the pairing target must be a real lecture, and the
  // exercise side must not itself be a solution/lecture. Even though the planner
  // only proposes role-valid matches, a stale possible_matches blob (written
  // before a file was re-typed) could let an invalid pair through. Confirming such
  // a pair would schedule a bogus task, so reject it. Roles are read from the
  // stored source_type (explicit, non-'lecture' tags are trusted).
  if (action === 'confirm') {
    const roleRes = await supaRequest<Array<{ id: string; source_type: string | null }>>(
      'GET',
      'documents?id=in.(' +
        [exerciseFileId, possibleLectureFileId].map(encodeURIComponent).join(',') +
        ')&select=id,source_type',
      null,
      auth.serviceKey
    );
    const roleById = new Map<string, string>(
      (Array.isArray(roleRes.body) ? roleRes.body : []).map((d) => [
        d.id,
        (d.source_type ?? '').trim().toLowerCase(),
      ])
    );
    const lectureRole = roleById.get(possibleLectureFileId);
    const exerciseRole = roleById.get(exerciseFileId);
    // Only reject on a KNOWN conflicting role (explicit, non-default tag), so an
    // untyped/legacy file still confirms — same best-effort stance as the planner.
    if (lectureRole === 'exercise' || lectureRole === 'solution') {
      return fail(422, 'The pairing target is not a lecture');
    }
    if (exerciseRole === 'solution' || exerciseRole === 'lecture') {
      return fail(422, 'The exercise side is not an exercise file');
    }
  }

  // On "confirm": insert a task row.
  if (action === 'confirm' && matchEntry) {
    const courseId = matchEntry.courseId ?? plan.course_id ?? '';
    const exerciseFileName = matchEntry.exerciseFileName ?? 'Exercise';

    const canonicalKey = buildCanonicalTaskKey(
      plan.plan_scope,
      planDate,
      courseId,
      'solve_exercise_sheet',
      possibleLectureFileId,
      exerciseFileId,
      '',      // solutionFileId
      [],      // lectureTopics
      '',      // pageRange
      ''       // repetitionStage
    );

    const taskRow = {
      plan_id: planId,
      user_id: auth.user.id,
      plan_date: planDate,
      day_order: 0,
      course_id: courseId,
      subject_name: null,
      topic_id: null,
      task_type: 'solve_exercise_sheet',
      task_title: 'Practice: ' + exerciseFileName,
      task_description: matchEntry?.reason ?? null,
      reason: matchEntry?.reason ?? null,
      source_file_id: possibleLectureFileId,
      exercise_file_id: exerciseFileId,
      solution_file_id: null,
      related_lecture_file_id: null,
      lecture_topics: [],
      related_lecture_topics: [],
      page_range: null,
      estimated_minutes: 25,
      status: 'todo',
      source_confidence: 'medium',
      priority_score: 0.6,
      repetition_stage: null,
      canonical_task_key: canonicalKey,
      study_state_required: 'studied',
      exercise_available: true,
      is_valid: true,
    };

    await supaRequest('POST', 'weekly_study_tasks', taskRow, auth.serviceKey, {
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  }

  // Record the decision durably so it survives plan regeneration and informs the
  // planner: a dismissed pair is never re-suggested, a confirmed pair is treated
  // as a known-good pairing the planner should use directly.
  const pairingCourseId = matchEntry?.courseId ?? plan.course_id ?? '';
  if (pairingCourseId) {
    await supaRequest(
      'POST',
      'student_exercise_pairings?on_conflict=user_id,exercise_file_id,lecture_file_id',
      {
        user_id: auth.user.id,
        course_id: pairingCourseId,
        exercise_file_id: exerciseFileId,
        lecture_file_id: possibleLectureFileId,
        status: action === 'confirm' ? 'confirmed' : 'dismissed',
        updated_at: new Date().toISOString(),
      },
      auth.serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    ).catch((err) => console.error('[study-possible-match] pairing persist failed (non-fatal):', err));
  }

  // Remove the entry from possible_matches (match on exerciseFileId + possibleLectureFileId).
  const updatedMatches = currentMatches.filter(
    (m) => !(m.exerciseFileId === exerciseFileId && m.possibleLectureFileId === possibleLectureFileId)
  );

  await supaRequest(
    'PATCH',
    'weekly_study_plans?id=eq.' + encodeURIComponent(planId),
    { possible_matches: updatedMatches },
    auth.serviceKey,
    { Prefer: 'return=minimal' }
  );

  return jsonResponse(200, { ok: true, remaining: updatedMatches.length });
};

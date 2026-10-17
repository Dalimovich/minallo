// POST /api/ai/german-exam/manifest — the exam structure (modules, parts, timings,
// scoring summary) for the authenticated learner's exam, for the profile-driven
// exam workspace. The profile is resolved from the SAVED profile
// (profiles.german_test + german_level); any client-supplied profileId is ignored,
// so a stale tab can never be handed another exam's structure.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured } from '../lib/python-ai-proxy';
import { getGermanLearnerProfile, unsupportedExamProfileMessage } from '../lib/german-learner-profile';
import { fetchExamManifest } from '../lib/german-exam-manifest';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const learner = await getGermanLearnerProfile(requireEnv('SUPABASE_SERVICE_ROLE_KEY'), user.id);
  if (!learner) return fail(503, 'Your profile could not be loaded right now. Please try again.');
  if (!learner.examProfileId) return fail(422, unsupportedExamProfileMessage(learner));

  const manifest = await fetchExamManifest(learner.examProfileId);
  if (!manifest) return fail(502, 'Exam structure is unavailable right now. Please try again.');
  return jsonResponse(200, { profileId: learner.examProfileId, manifest });
};

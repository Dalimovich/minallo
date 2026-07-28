// POST /api/ai/writing-coach — proxy to Python /writing-coach-analyse.
//
// Auth: Supabase JWT. Body: { text, profileLevel, taskType?, explanationLanguage? }.
// userId is taken from the verified token; never trusted from the client.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceInteractiveCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const RATE_LIMIT_MAX = parseInt(optionalEnv('WRITING_COACH_RATE_LIMIT_MAX', '20'), 10);
const RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('WRITING_COACH_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
const MAX_TEXT_CHARS = 8000;
const ALLOWED_TASK_TYPES = new Set([
  'email',
  'stellungnahme',
  'argumentation',
  'zusammenfassung',
  'bericht',
  'motivationsschreiben',
  'freier_text'
]);
const ALLOWED_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C1 Hochschule', 'C2']);
const ALLOWED_EXPLANATION_LANGUAGES = new Set(['English', 'German', 'Simple']);

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'writing_coach_analyse');
  if (subBlocked) return subBlocked;
  const monthlyCapped = await enforceInteractiveCap(serviceKey, user.id);
  if (monthlyCapped) return monthlyCapped;
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'writing_coach_analyse',
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW,
    'Writing coach limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return fail(400, 'text is required');
  if (text.length > MAX_TEXT_CHARS) return fail(400, 'text is too long');

  const profileLevel = typeof body.profileLevel === 'string' ? body.profileLevel : '';
  if (!ALLOWED_LEVELS.has(profileLevel)) return fail(400, 'profileLevel is invalid');

  const rawTask = typeof body.taskType === 'string' ? body.taskType : 'freier_text';
  const taskType = ALLOWED_TASK_TYPES.has(rawTask) ? rawTask : 'freier_text';

  const rawLang =
    typeof body.explanationLanguage === 'string' ? body.explanationLanguage : 'English';
  const explanationLanguage = ALLOWED_EXPLANATION_LANGUAGES.has(rawLang) ? rawLang : 'English';

  await logSecurityEvent(serviceKey, user.id, 'writing_coach_analyse', {
    profile_level: profileLevel,
    task_type: taskType,
    char_count: text.length
  });

  const upstream = await forwardToPython('writing-coach-analyse', {
    userId: user.id,
    text,
    profileLevel,
    taskType,
    explanationLanguage
  });
  if (!upstream.ok) {
    const err = (upstream.body as { error?: string; detail?: string }).error
      || (upstream.body as { detail?: string }).detail;
    return jsonResponse(upstream.status === 400 ? 400 : 502, {
      error: 'Writing coach is temporarily unavailable: ' + (err || 'upstream ' + upstream.status)
    });
  }
  return jsonResponse(200, upstream.body);
};

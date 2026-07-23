// POST /api/ai/cheatsheet — proxy to the Python cheatsheet endpoint.
//
// Learning Agent Phase 4. Generates a dense, Topic-Map-driven, source-grounded
// cheatsheet from the user's own materials and (by default) saves it as a note
// of type 'cheatsheet', so it appears in the existing notes list.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const AI_GENERATE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_MAX', '30'), 10);
const AI_GENERATE_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_DOCUMENT_IDS = 25;
const MAX_TOPIC_LENGTH = 500;

interface PyCheatsheetResponse {
  noteId?: string | null;
  title?: string | null;
  text?: string;
  topicsCovered?: unknown[];
  groundedSources?: unknown[];
  settings?: unknown;
  grounding?: unknown;
  quality?: unknown;
  warning?: string;
  citationWarning?: string;
  error?: string;
}

function _docIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_DOCUMENT_IDS);
}

// Whitelist + clamp settings before forwarding — never trust the client body.
// Only preset + two overrides are accepted; everything else is dropped.
const _VALID_PRESETS = ['exam_night', 'open_book_exam', 'formula_reference', 'balanced', 'deep_revision', 'topic_mastery'];
const _VALID_LANGS = ['source', 'en', 'de', 'de_terms_en_explanations'];
const _VALID_STYLES = ['academic', 'modern', 'compact', 'classic'];
const _VALID_FONT_SIZES = ['auto', 'small', 'medium', 'large'];
const _VALID_DETAIL_LEVELS = ['general', 'balanced', 'specific', 'very_thorough'];
const _VALID_FOCUS_MODES = ['whole_course', 'specific_topic', 'selected_files', 'selected_pages'];
const _VALID_OUTPUTS = ['web', 'pdf', 'both'];

function _settings(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.preset === 'string' && _VALID_PRESETS.includes(s.preset)) out.preset = s.preset;
  if (typeof s.pages === 'number' && s.pages >= 1 && s.pages <= 4) out.pages = Math.floor(s.pages);
  if (typeof s.columns === 'number' && s.columns >= 2 && s.columns <= 4) out.columns = Math.floor(s.columns);
  if (typeof s.style === 'string' && _VALID_STYLES.includes(s.style)) out.style = s.style;
  if (typeof s.fontSize === 'string' && _VALID_FONT_SIZES.includes(s.fontSize)) out.fontSize = s.fontSize;
  if (typeof s.detailLevel === 'string' && _VALID_DETAIL_LEVELS.includes(s.detailLevel)) out.detailLevel = s.detailLevel;
  if (typeof s.focusMode === 'string' && _VALID_FOCUS_MODES.includes(s.focusMode)) out.focusMode = s.focusMode;
  if (typeof s.language === 'string' && _VALID_LANGS.includes(s.language)) out.language = s.language;
  if (typeof s.output === 'string' && _VALID_OUTPUTS.includes(s.output)) out.output = s.output;
  return Object.keys(out).length ? out : null;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_generate');
  if (subBlocked) return subBlocked;

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const courseId = body.courseId;
  const topic = body.topic;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (typeof topic === 'string' && topic.length > MAX_TOPIC_LENGTH) return fail(400, 'topic is too long');
  const docIds = _docIds(body.documentIds ?? body.docIds);
  const settings = _settings(body.settings);

  const monthlyCapped = await enforceGenerationCap(serviceKey, user.id);
  if (monthlyCapped) return monthlyCapped;
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_generate',
    AI_GENERATE_RATE_LIMIT_MAX,
    AI_GENERATE_RATE_LIMIT_WINDOW,
    'Generation limit reached. Please try again later.'
  );
  if (limited) return limited;

  await logSecurityEvent(serviceKey, user.id, 'ai_generate', {
    course_id: courseId,
    tool: 'cheatsheet',
    document_count: docIds ? docIds.length : 0,
  });

  const upstream = await forwardToPython<PyCheatsheetResponse>('generate-cheatsheet', {
    userId: user.id,
    courseId,
    documentIds: docIds,
    topic: typeof topic === 'string' ? topic : null,
    save: true,
    settings,
  });
  if (!upstream.ok) {
    const err = (upstream.body as { error?: string }).error;
    return jsonResponse(200, {
      noteId: null,
      title: 'Cheatsheet',
      text: '',
      topicsCovered: [],
      groundedSources: [],
      error: 'Cheatsheet is temporarily unavailable: ' + (err || 'upstream ' + upstream.status),
    });
  }
  return jsonResponse(200, upstream.body);
};

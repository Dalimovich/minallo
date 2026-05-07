// POST /api/ai/generate
// Thin HTTP handler — all generation logic lives in backend/lib/study-pipeline.js
//
// Request body:
//   { courseId, tool, topic?, count?, difficulty?, documentIds? }
//   tool: "flashcards" | "quiz" | "summary"
//
// Response:
//   { tool, items, sources, error? }

const { requireEnv }  = require('../lib/env');
const { jsonResponse, fail, handleOptions } = require('../lib/responses');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');
const { runPipeline } = require('../lib/study-pipeline');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST')    return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');

  const user = await verifySupabaseToken(token);
  if (!user)  return fail(401, 'Invalid or expired token');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return fail(400, 'Invalid JSON'); }

  const { courseId, tool, topic, count, difficulty, documentIds } = body;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (!['flashcards', 'quiz', 'summary'].includes(tool))
    return fail(400, 'tool must be flashcards, quiz, or summary');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const docIds     = Array.isArray(documentIds) && documentIds.length ? documentIds : null;

  let result;
  try {
    result = await runPipeline({ serviceKey, userId: user.id, courseId, tool, topic, count, difficulty, docIds });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('ai-generate pipeline error:', msg);
    return jsonResponse(200, { tool, items: [], text: '', sources: [], error: 'AI generation is temporarily unavailable: ' + msg });
  }

  return jsonResponse(200, Object.assign({ tool }, result));
};

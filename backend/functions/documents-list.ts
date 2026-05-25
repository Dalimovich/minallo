// GET /api/documents/list?courseId=xxx

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const courseId = (event.queryStringParameters || {}).courseId;
  if (!courseId) return fail(400, 'courseId query parameter is required');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const result = await supaRequest<unknown[]>(
    'GET',
    'documents?user_id=eq.' + user.id +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,file_name,file_type,source_type,processing_status,processing_error,page_count,extraction_quality,ocr_assessment,created_at,updated_at' +
      '&order=created_at.desc',
    null, serviceKey
  );
  if (!Array.isArray(result.body)) return fail(500, 'Failed to fetch documents');
  return jsonResponse(200, { documents: result.body });
};

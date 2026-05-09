const { requireEnv } = require('../lib/env');
const { jsonResponse, fail } = require('../lib/responses');
const { supaRequest } = require('../lib/supabase-admin');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');

exports.handler = async function (event) {
  const corsHeaders = Object.assign(require('../lib/cors').getCorsHeaders(), {
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');

  const user = await verifySupabaseToken(token);
  if (!user || !user.id) return fail(401, 'Invalid or expired session');

  const username = String(
    (event.queryStringParameters && event.queryStringParameters.username) || ''
  )
    .trim()
    .toLowerCase();
  if (!username || username.length < 3 || !/^[a-z0-9_]+$/.test(username)) {
    return fail(400, 'Invalid username');
  }

  try {
    const res = await supaRequest(
      'GET',
      'public_profiles?chat_username=eq.' + encodeURIComponent(username) + '&select=id&limit=1',
      null,
      serviceKey
    );
    if (res.status < 200 || res.status >= 300) return fail(500, 'Could not check username');

    const row = Array.isArray(res.body) ? res.body[0] : null;
    const available = !row || row.id === user.id;
    return jsonResponse(200, { available });
  } catch (e) {
    return fail(500, e.message);
  }
};

const { requireEnv } = require('../lib/env');
const { jsonResponse, fail } = require('../lib/responses');
const { supaRequest } = require('../lib/supabase-admin');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');

function escLike(value) {
  return String(value || '').replace(/[,%]/g, '');
}

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

  const q = escLike((event.queryStringParameters && event.queryStringParameters.q) || '').trim();
  if (q.length < 2) return fail(400, 'Search query must be at least 2 characters');

  try {
    const blockedPath =
      'blocked_users?or=(' +
      'blocker_id.eq.' +
      encodeURIComponent(user.id) +
      ',' +
      'blocked_id.eq.' +
      encodeURIComponent(user.id) +
      ')&select=blocker_id,blocked_id';
    const blockedRes = await supaRequest('GET', blockedPath, null, serviceKey);
    if (blockedRes.status < 200 || blockedRes.status >= 300)
      return fail(500, 'Could not load blocked users');

    const blockedIds = new Set(
      (Array.isArray(blockedRes.body) ? blockedRes.body : [])
        .map(function (row) {
          return row.blocker_id === user.id ? row.blocked_id : row.blocker_id;
        })
        .filter(Boolean)
    );

    const qEnc = encodeURIComponent('*' + q + '*');
    const select = 'select=id,full_name,chat_username,programme&limit=8';
    const seen = {};
    const rows = [];
    const paths = [
      'public_profiles?full_name=ilike.' + qEnc + '&' + select,
      'public_profiles?chat_username=ilike.' + qEnc + '&' + select
    ];

    for (const path of paths) {
      const res = await supaRequest('GET', path, null, serviceKey);
      if (res.status < 200 || res.status >= 300) return fail(500, 'Profile search failed');
      const data = Array.isArray(res.body) ? res.body : [];
      data.forEach(function (p) {
        if (!p || !p.id || p.id === user.id || blockedIds.has(p.id) || seen[p.id]) return;
        seen[p.id] = true;
        rows.push({
          id: p.id,
          full_name: p.full_name || null,
          chat_username: p.chat_username || null,
          programme: p.programme || ''
        });
      });
    }

    return jsonResponse(200, { users: rows.slice(0, 8) });
  } catch (e) {
    return fail(500, e.message);
  }
};

const { requireEnv } = require('../lib/env');
const { jsonResponse, fail } = require('../lib/responses');
const { supaRequest } = require('../lib/supabase-admin');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');

exports.handler = async function (event) {
  // chat-friends uses GET, not POST
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
  if (!user) return fail(401, 'Invalid or expired session');

  try {
    const friendshipPath =
      'friendships?or=(' +
      'user_id.eq.' +
      encodeURIComponent(user.id) +
      ',' +
      'friend_id.eq.' +
      encodeURIComponent(user.id) +
      ')&select=id,user_id,friend_id,status';
    const friendshipRes = await supaRequest('GET', friendshipPath, null, serviceKey);
    if (friendshipRes.status < 200 || friendshipRes.status >= 300)
      return fail(500, 'Could not load friendships');

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

    const rows = (Array.isArray(friendshipRes.body) ? friendshipRes.body : []).filter(function (r) {
      const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
      return otherId && !blockedIds.has(otherId);
    });
    const otherIds = Array.from(
      new Set(
        rows
          .map(function (r) {
            return r.user_id === user.id ? r.friend_id : r.user_id;
          })
          .filter(Boolean)
      )
    );

    const profileMap = {};
    if (otherIds.length) {
      const profilePath =
        'public_profiles?id=in.(' +
        otherIds.map(encodeURIComponent).join(',') +
        ')&select=id,full_name,chat_username,programme,last_seen';
      const profileRes = await supaRequest('GET', profilePath, null, serviceKey);
      const profiles = Array.isArray(profileRes.body) ? profileRes.body : [];
      profiles.forEach(function (p) {
        profileMap[p.id] = p;
      });
    }

    const friends = rows.map(function (r) {
      const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
      const prof = profileMap[otherId] || {};
      return {
        id: r.id,
        otherId,
        status: r.status,
        isSender: r.user_id === user.id,
        profile: {
          id: otherId,
          full_name: prof.full_name || prof.chat_username || 'Student',
          chat_username: prof.chat_username || null,
          programme: prof.programme || '',
          last_seen: prof.last_seen || null
        }
      };
    });

    return jsonResponse(200, { friends });
  } catch (e) {
    return fail(500, e.message);
  }
};

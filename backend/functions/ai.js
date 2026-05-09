const https = require('https');
const { requireEnv } = require('../lib/env');
const { fail, handleOptions } = require('../lib/responses');
const { verifySupabaseToken, extractBearerToken } = require('../lib/supabase-auth');
const { logSecurityEvent } = require('../lib/logger');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_SYSTEM_CHARS = 120000;
const MAX_TEXT_CHARS = 120000;
const MAX_IMAGE_BLOCKS = 5;
const MAX_IMAGE_BASE64_CHARS = 1500000;
const MAX_COMPLETION_TOKENS = 2048;
const ALLOWED_ROLES = { user: true, assistant: true, system: true };
const ALLOWED_IMAGE_MEDIA_TYPES = {
  'image/png': true,
  'image/jpeg': true,
  'image/jpg': true,
  'image/webp': true,
  'image/gif': true
};

function requestShapeSummary(incoming) {
  const messages = Array.isArray(incoming && incoming.messages) ? incoming.messages : [];
  let textChars = 0;
  let imageBlocks = 0;

  messages.forEach(function (m) {
    if (!m) return;
    if (typeof m.content === 'string') {
      textChars += m.content.length;
      return;
    }
    if (!Array.isArray(m.content)) return;
    m.content.forEach(function (part) {
      if (!part || typeof part !== 'object') return;
      if (part.type === 'text') {
        textChars += String(part.text || '').length;
      } else if (part.type === 'image') {
        imageBlocks += 1;
      }
    });
  });

  return {
    message_count: messages.length,
    text_chars: textChars,
    image_blocks: imageBlocks,
    requested_max_tokens: Number((incoming && incoming.max_tokens) || 1024)
  };
}

function rejectAndLog(statusCode, message, serviceKey, userId, reasonCode, metadata) {
  return logSecurityEvent(
    serviceKey,
    userId,
    'ai_request_rejected',
    Object.assign(
      {
        reason: reasonCode
      },
      metadata || {}
    )
  ).then(function () {
    return fail(statusCode, message);
  });
}

function convertContent(content, counters) {
  if (typeof content === 'string') {
    counters.textChars += content.length;
    if (counters.textChars > MAX_TEXT_CHARS) throw new Error('AI request text is too large');
    return content;
  }

  if (!Array.isArray(content))
    throw new Error('Message content must be text or an array of content blocks');

  var parts = [];
  content.forEach(function (b) {
    if (!b || typeof b !== 'object') throw new Error('Invalid message content block');
    if (b.type === 'text') {
      const text = String(b.text || '');
      counters.textChars += text.length;
      if (counters.textChars > MAX_TEXT_CHARS) throw new Error('AI request text is too large');
      parts.push({ type: 'text', text });
    } else if (b.type === 'image' && b.source && b.source.type === 'base64') {
      const mediaType = String(b.source.media_type || '');
      const data = String(b.source.data || '');
      counters.images += 1;
      if (!ALLOWED_IMAGE_MEDIA_TYPES[mediaType]) throw new Error('Unsupported image type');
      if (counters.images > MAX_IMAGE_BLOCKS) throw new Error('Too many images in one AI request');
      if (!data || data.length > MAX_IMAGE_BASE64_CHARS)
        throw new Error('Attached image is too large');
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('Attached image is not valid base64');
      parts.push({
        type: 'image_url',
        image_url: { url: 'data:' + mediaType + ';base64,' + data }
      });
    } else {
      throw new Error('Unsupported message content block');
    }
  });

  if (!parts.length) return '';
  if (
    parts.every(function (p) {
      return p.type === 'text';
    })
  ) {
    return parts
      .map(function (p) {
        return p.text;
      })
      .join('\n');
  }
  return parts;
}

function normalizeMaxTokens(value) {
  const parsed = Number(value || 1024);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1024;
  return Math.min(Math.floor(parsed), MAX_COMPLETION_TOKENS);
}

function buildOpenAiMessages(incoming) {
  const counters = { textChars: 0, images: 0 };
  const incomingMessages = incoming.messages;
  if (!Array.isArray(incomingMessages) || !incomingMessages.length) {
    throw new Error('Missing messages');
  }
  if (incomingMessages.length > MAX_MESSAGES) {
    throw new Error('Too many messages in one AI request');
  }

  const messages = incomingMessages.map(function (m) {
    if (!m || typeof m !== 'object') throw new Error('Invalid message');
    if (!ALLOWED_ROLES[m.role]) throw new Error('Invalid message role');
    return { role: m.role, content: convertContent(m.content, counters) };
  });

  if (incoming.system) {
    const system = String(incoming.system);
    if (system.length > MAX_SYSTEM_CHARS) throw new Error('System prompt is too large');
    counters.textChars += system.length;
    if (counters.textChars > MAX_TEXT_CHARS + MAX_SYSTEM_CHARS)
      throw new Error('AI request text is too large');
    return [{ role: 'system', content: system }].concat(messages);
  }

  return messages;
}

exports.handler = async function (event) {
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_BODY_BYTES) {
    return rejectAndLog(413, 'AI request is too large', serviceKey, null, 'body_too_large', {
      body_bytes: Buffer.byteLength(event.body || '', 'utf8')
    });
  }

  const token = extractBearerToken(event.headers);
  if (!token) {
    return rejectAndLog(401, 'Unauthorized', serviceKey, null, 'missing_token');
  }

  const user = await verifySupabaseToken(token);
  if (!user) {
    return rejectAndLog(401, 'Invalid or expired session', serviceKey, null, 'invalid_token');
  }

  const key = requireEnv('OPENAI_API_KEY');

  try {
    let incoming;
    try {
      incoming = JSON.parse(event.body || '{}');
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return rejectAndLog(400, 'Invalid JSON body', serviceKey, user.id, 'invalid_json_shape');
      }
    } catch (e) {
      return rejectAndLog(400, 'Invalid JSON body', serviceKey, user.id, 'invalid_json');
    }

    const openaiMessages = buildOpenAiMessages(incoming);

    const openaiBody = JSON.stringify({
      model: 'gpt-4o',
      max_completion_tokens: normalizeMaxTokens(incoming.max_tokens),
      messages: openaiMessages
    });

    const result = await new Promise(function (resolve, reject) {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
            'Content-Length': Buffer.byteLength(openaiBody)
          }
        },
        function (res) {
          var data = '';
          res.on('data', function (chunk) {
            data += chunk;
          });
          res.on('end', function () {
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('error', reject);
      req.write(openaiBody);
      req.end();
    });

    const oai = JSON.parse(result.body);

    let converted;
    let statusCode = 200;
    if (oai.error) {
      statusCode = result.status >= 400 ? result.status : 502;
      converted = { error: oai.error };
    } else {
      const text =
        oai.choices && oai.choices[0] && oai.choices[0].message
          ? oai.choices[0].message.content
          : '';
      converted = { content: [{ type: 'text', text: text }] };
      await logSecurityEvent(
        serviceKey,
        user.id,
        'ai_request',
        Object.assign(requestShapeSummary(incoming), {
          max_completion_tokens: normalizeMaxTokens(incoming.max_tokens)
        })
      );
    }

    return {
      statusCode,
      headers: require('../lib/cors').getCorsHeaders(),
      body: JSON.stringify(converted)
    };
  } catch (e) {
    const isValidationError =
      /request|message|image|role|JSON|Unsupported|Missing|Invalid|Too many|large|base64/i.test(
        e.message
      );
    if (isValidationError) {
      return rejectAndLog(400, e.message, serviceKey, user.id, 'validation_error');
    }
    return fail(500, e.message);
  }
};

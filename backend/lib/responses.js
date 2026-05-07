const { getCorsHeaders } = require('./cors');
const logger = require('./logger'); // Assumed logger exists based on README

function jsonResponse(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(getCorsHeaders(), extraHeaders || {}),
    body: JSON.stringify(body)
  };
}

function fail(statusCode, message) {
  return jsonResponse(statusCode, { error: { message } });
}

function handleOptions() {
  return { statusCode: 204, headers: getCorsHeaders(), body: '' };
}

function withHandler(handler) {
  return async function (event, context) {
    if (event.httpMethod === 'OPTIONS') return handleOptions();
    try {
      return await handler(event, context);
    } catch (err) {
      // Log full error details for debugging, but don't return them to the client
      console.error('[Backend Error]:', {
        message: err.message,
        path: event.path,
        userId: context.clientContext?.user?.sub
      });

      const message = err && err.message ? err.message : 'Internal server error';
      const status = err && err.statusCode ? err.statusCode : 500;
      return fail(status, message);
    }
  };
}

module.exports = { jsonResponse, fail, handleOptions, withHandler };

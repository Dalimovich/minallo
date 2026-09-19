import { getCorsHeaders } from './cors';
import type { HttpHeaders, LambdaResponse, NetlifyContext, NetlifyEvent } from './types';

export function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders?: HttpHeaders
): LambdaResponse {
  return {
    statusCode,
    // API responses must never be cached by the browser — a stale daily-plan /
    // mission response otherwise keeps showing deleted/old tasks after the DB
    // changed. Callers can still override via extraHeaders if a route opts in.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...getCorsHeaders(), ...(extraHeaders || {}) },
    body: JSON.stringify(body)
  };
}

/** Relays a python-ai failure as structured JSON.
 *
 *  Cloudflare replaces a 502/504 coming back from a Pages origin with its own
 *  generic HTML error page (the learner then sees "Bad gateway" and no
 *  reference id). Those two statuses are therefore sent as 500 with the real
 *  one preserved in `upstreamStatus`; every other status passes through. */
export function upstreamFailureResponse(status: number, body: unknown): LambdaResponse {
  const obj: Record<string, unknown> =
    body && typeof body === 'object' && !('raw' in (body as Record<string, unknown>))
      ? { ...(body as Record<string, unknown>) }
      : {};
  const rawDetail = obj.detail ?? obj.error;
  const detail = typeof rawDetail === 'string' && rawDetail ? rawDetail : 'The AI service could not complete this request.';
  const outStatus = status === 502 || status === 504 ? 500 : status;
  return jsonResponse(outStatus, { ...obj, detail, error: detail, upstreamStatus: status });
}

export function fail(statusCode: number, message: string): LambdaResponse {
  return jsonResponse(statusCode, { error: { message } });
}

export function handleOptions(): LambdaResponse {
  return { statusCode: 204, headers: getCorsHeaders(), body: '' };
}

export type NetlifyHandler = (
  event: NetlifyEvent,
  context: NetlifyContext
) => Promise<LambdaResponse>;

interface ErrorWithStatus extends Error {
  statusCode?: number;
}

export function withHandler(handler: NetlifyHandler): NetlifyHandler {
  return async function (event, context) {
    if (event.httpMethod === 'OPTIONS') return handleOptions();
    try {
      return await handler(event, context);
    } catch (raw: unknown) {
      const err = raw as ErrorWithStatus;
      console.error('[Backend Error]:', {
        message: err && err.message,
        path: event.path,
        userId: context.clientContext?.user?.sub
      });
      const status = err && err.statusCode ? err.statusCode : 500;
      const message = status >= 500 ? 'Internal server error' : (err && err.message ? err.message : 'Request failed');
      return fail(status, message);
    }
  };
}

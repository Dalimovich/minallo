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
    headers: { 'Cache-Control': 'no-store', ...getCorsHeaders(), ...(extraHeaders || {}) },
    body: JSON.stringify(body)
  };
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

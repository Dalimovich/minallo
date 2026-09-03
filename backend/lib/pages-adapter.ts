// Cloudflare Pages Functions adapter. Wraps existing Netlify-style handlers
// (event, context → LambdaResponse) so they run unchanged on the Workers
// runtime that Pages Functions use. Per-route shim files in /functions/api/*
// just call this — no per-handler edits required.

import type { LambdaResponse, NetlifyContext, NetlifyEvent } from './types';

interface PagesEventContext<Env = unknown> {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  waitUntil: (promise: Promise<unknown>) => void;
  next: () => Promise<Response>;
  data: Record<string, unknown>;
}

export type NetlifyHandler = (
  event: NetlifyEvent,
  context: NetlifyContext
) => Promise<LambdaResponse>;

/** Build a NetlifyEvent from a Pages Request. ``rawBody`` controls whether
 * the body is left as a string (default — JSON / form / text handlers) or
 * read as base64 (Stripe / PayPal signature verification needs the exact
 * byte sequence; consumers re-decode it). */
async function toNetlifyEvent(
  request: Request,
  rawBody: 'utf8' | 'base64' = 'utf8'
): Promise<NetlifyEvent> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const qs: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    qs[k] = v;
  });

  let body: string | null = null;
  let isBase64 = false;
  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    if (rawBody === 'base64') {
      const buf = new Uint8Array(await request.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
      body = btoa(bin);
      isBase64 = true;
    } else {
      body = await request.text();
    }
  }

  return {
    httpMethod: request.method,
    path: url.pathname,
    headers,
    queryStringParameters: qs,
    body,
    isBase64Encoded: isBase64
  };
}

function toResponse(r: LambdaResponse): Response {
  return new Response(r.body, {
    status: r.statusCode,
    headers: r.headers || {}
  });
}

/** Wrap a Netlify handler so it can be exported as a Pages Functions
 * ``onRequest`` handler. The default proxies env vars from Pages to
 * ``process.env`` so existing helpers (`requireEnv`, `optionalEnv`) keep
 * working without changes. */
interface ErrorWithStatus extends Error {
  statusCode?: number;
}

export function pagesAdapter(
  handler: NetlifyHandler,
  opts: { rawBody?: 'utf8' | 'base64' } = {}
) {
  return async (ctx: PagesEventContext<Record<string, string>>): Promise<Response> => {
    if (ctx.env && typeof ctx.env === 'object') {
      const proc = (globalThis as { process?: { env: Record<string, string> } }).process;
      if (proc && proc.env) {
        for (const [k, v] of Object.entries(ctx.env)) {
          if (typeof v === 'string' && proc.env[k] === undefined) proc.env[k] = v;
        }
      } else {
        (globalThis as { process?: { env: Record<string, string> } }).process = {
          env: { ...(ctx.env as Record<string, string>) }
        };
      }
    }
    const event = await toNetlifyEvent(ctx.request, opts.rawBody || 'utf8');
    // Route-level handlers below this adapter are Netlify-style and mostly
    // rely on withHandler (responses.ts) for exception safety — but that's
    // opt-in per handler, and this adapter didn't apply it. An uncaught
    // throw here (a missing env var from requireEnv(), a rejected fetch()
    // with no local catch, anything unexpected) propagated straight out of
    // this function, and Cloudflare Pages turns an uncaught Worker
    // exception into its own generic "Error 1101" HTML crash page instead
    // of the handler's own JSON error shape — invisible to the frontend's
    // own error handling and to anyone without direct Workers log access.
    // Mirrors withHandler's own catch shape so behavior is consistent
    // whether or not the wrapped handler also applies it itself.
    try {
      const result = await handler(event, {} as NetlifyContext);
      return toResponse(result);
    } catch (raw: unknown) {
      const err = raw as ErrorWithStatus;
      console.error('[Pages Function Error]:', {
        message: err && err.message,
        path: event.path,
        stack: err && err.stack
      });
      const status = err && err.statusCode ? err.statusCode : 500;
      const message = status >= 500 ? 'Internal server error' : (err && err.message ? err.message : 'Request failed');
      return toResponse({
        statusCode: status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: { message } })
      });
    }
  };
}

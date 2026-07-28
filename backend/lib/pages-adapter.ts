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
    const result = await handler(event, {} as NetlifyContext);
    return toResponse(result);
  };
}

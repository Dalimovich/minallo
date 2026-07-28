import { optionalEnv, requireEnv } from './env';
import type { HttpHeaders } from './types';

// In production ALLOWED_ORIGIN must be set in the host's env vars.
// In local dev (netlify dev / wrangler pages dev / unit tests) it falls
// back to localhost. Never falls back to '*' which would allow any origin.
//
// Production detection works across hosts: NETLIFY/CONTEXT (Netlify),
// CF_PAGES (Cloudflare Pages — set to "1" in production + preview builds).
function resolveOrigin(): string {
  const configured = optionalEnv('ALLOWED_ORIGIN', '');
  if (configured) return configured;
  const isProd =
    optionalEnv('NETLIFY', '') === 'true' ||
    optionalEnv('CONTEXT', '') === 'production' ||
    optionalEnv('CF_PAGES', '') === '1';
  if (isProd) {
    return requireEnv('ALLOWED_ORIGIN');
  }
  return 'http://localhost:8888';
}

export function getCorsHeaders(): HttpHeaders {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, PATCH, DELETE, OPTIONS'
  };
}
